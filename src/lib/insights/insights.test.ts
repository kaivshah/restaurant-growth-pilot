import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOffers, type OfferRules } from "@/lib/offers";
import { parseReportFile, type ParsedReport } from "@/lib/reports";
import { computeInsights } from "./index";

async function loadAll(dir: string, files: string[]): Promise<ParsedReport[]> {
  const out: ParsedReport[] = [];
  for (const f of files) {
    const buf = readFileSync(join(dir, f));
    const r = await parseReportFile(f, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (!r.ok) throw new Error(`${f}: ${r.message}`);
    out.push(r.report);
  }
  return out;
}

const SAMPLE = join(process.cwd(), "fixtures", "sample");
const SAMPLE_FILES = [
  "DayPartSalesAndUnitsReport20260304.csv",
  "SalesSummary_00000_3-10-2026.csv",
  "UnitsSummary_00000_3-10-2026.csv",
  "AdjustedCostOfGoods_00000_3-10-2026.csv",
  "InventoryCategoriesSummary_00000_3-10-2026.csv",
  "InventoryItems_00000_3-10-2026.csv",
  "DailyCashBreadOverShort_00000_3-10-2026.csv",
];

const rules = (over: Partial<OfferRules> = {}): OfferRules => ({
  promoApproval: "UNSURE",
  maxDiscountPct: 15,
  allowFreeExtra: true,
  allowPercentOff: true,
  ...over,
});

describe("insights from sample reports", () => {
  it("computes the headline numbers", async () => {
    const ins = computeInsights(await loadAll(SAMPLE, SAMPLE_FILES));
    expect(ins.netSales).toBe(6250);
    expect(ins.cateringSales).toBe(250);
    expect(ins.drinkPct).toBe(50);
    expect(ins.drinkPrice).toBe(2.67); // 600 / 225
    expect(ins.discountPctOfSales).toBe(16);
    expect(ins.hourly?.bars[0].label).toBe("9a");
    expect(ins.hourly?.bars.at(-1)?.label).toBe("9p");
    expect(ins.overuse[0]).toEqual({ category: "VEGGIES", dollars: 80 });
    expect(ins.unitCosts["chips"]).toBe(0.7);
    expect(ins.bread?.weekendSurplus).toBe(170); // Sat 20 + Sun 100 + Mon 50
  });

  it("builds offers that respect the discount limit", async () => {
    const ins = computeInsights(await loadAll(SAMPLE, SAMPLE_FILES));
    // A $2.67 drink is 21% of a $12.50 ticket: too much at 15%, so it becomes a $1 drink (13%).
    const capped = buildOffers(ins, rules({ maxDiscountPct: 15 }));
    expect(capped.find((o) => o.key === "afternoon-drink")?.title).toBe("$1 fountain drink with any footlong, 3–5 pm");
    // At 25% the free drink fits.
    const generous = buildOffers(ins, rules({ maxDiscountPct: 25 }));
    expect(generous.find((o) => o.key === "afternoon-drink")?.title).toBe("Free fountain drink with any footlong, 3–5 pm");
    // At 10% neither fits, so there is no drink offer at all.
    expect(buildOffers(ins, rules({ maxDiscountPct: 10 })).some((o) => o.key === "afternoon-drink")).toBe(false);
  });

  it("adds a brand check in brand-safe mode and skips giveaways when they're not allowed", async () => {
    const ins = computeInsights(await loadAll(SAMPLE, SAMPLE_FILES));
    expect(buildOffers(ins, rules()).every((o) => o.checks.includes("Check with your brand before sending"))).toBe(true);
    expect(buildOffers(ins, rules({ promoApproval: "YES" })).some((o) => o.checks.includes("Check with your brand before sending"))).toBe(false);
    expect(buildOffers(ins, rules({ allowFreeExtra: false }))).toEqual([]);
  });
});

const PRIVATE = join(process.cwd(), "fixtures", "private");
const PRIVATE_FILES = [
  "DayPartSalesAndUnitsReport20260826.csv",
  "SalesSummary_32105_8-18-2026.csv",
  "UnitsSummary_32105_8-18-2026.csv",
  "AdjustedCostOfGoods_32105_8-18-2026.csv",
  "InventoryCategoriesSummary_32105_8-18-2026.csv",
  "DailyCashBreadOverShort_32105_8-18-2026.csv",
];

describe.runIf(PRIVATE_FILES.every((f) => existsSync(join(PRIVATE, f))))("insights for the pilot store (private)", () => {
  it("matches the numbers in the brainstorm document", async () => {
    const ins = computeInsights(await loadAll(PRIVATE, PRIVATE_FILES));
    expect(ins.hourly?.lunchShare).toBe(41);
    expect(ins.hourly?.weekSales).toBe(7621.47);
    expect(ins.drinkPct).toBe(38);
    expect(ins.drinkPrice).toBe(2.5);
    expect(ins.discountPctOfSales).toBe(25.1);
    expect(ins.cateringSales).toBe(0);
    expect(ins.bread?.surplusDays.find((d) => d.day === "Sun")?.bread).toBe(743);
    expect(ins.overuse.map((o) => o.category)).toEqual(["VEGGIES", "TOPPINGS", "CHEESE"]);
    expect(ins.days?.busiest).toEqual({ day: "Wed", sales: 1282.43 });

    const offers = buildOffers(ins, rules());
    expect(offers.map((o) => o.key)).toEqual(["welcome", "afternoon-drink", "weekend-bread"]);
    // $2.50 is 18% of a $13.60 ticket, over the 15% limit, so it's a $1 drink.
    expect(offers[1].title).toBe("$1 fountain drink with any footlong, 3–5 pm");
  });
});

describe("several weeks of reports", () => {
  it("averages the latest weeks (up to 8), so one odd week doesn't decide everything", async () => {
    const reports = await loadAll(SAMPLE, SAMPLE_FILES);
    const sales = reports.find((r) => r.type === "wisrSales")!;
    const day = reports.find((r) => r.type === "dayPart")!;
    // Nine more weeks of the same store, each with double the sales; only the latest 8 should count.
    const week = (n: number) => {
      const end = new Date(Date.parse(sales.period!.end) + n * 7 * 86_400_000).toISOString().slice(0, 10);
      return { start: new Date(Date.parse(end) - 6 * 86_400_000).toISOString().slice(0, 10), end };
    };
    const more: ParsedReport[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [
      { ...sales, period: week(n), netSales: sales.type === "wisrSales" ? sales.netSales * 2 : 0 } as ParsedReport,
      { ...day, period: week(n) } as ParsedReport,
    ]);
    const one = computeInsights(reports);
    const many = computeInsights([...reports, ...more]);
    expect(one.weeks).toEqual({ dayPart: 1, wisr: 1 });
    expect(many.weeks).toEqual({ dayPart: 8, wisr: 8 });
    expect(many.netSales).toBe(Math.round(one.netSales! * 2 * 100) / 100); // the 8 doubled weeks, not the old one
    expect(many.period.wisr).toBe(week(9).end);
    expect(many.hourly?.lunchShare).toBe(one.hourly?.lunchShare); // same pattern every week
  });
});

describe("averaging lists that change week to week", () => {
  it("matches inventory items by name instead of giving up on the average", async () => {
    const { averagedReport } = await import("./index");
    const week = (end: string, items: [string, number][]) =>
      ({
        type: "wisrInventoryItems",
        storeNumber: null,
        period: { start: end, end },
        items: items.map(([item, used]) => ({ item, isSubtotal: false, open: null, delivered: null, left: null, used, posDiff: null, unitCost: 0.4, usedDollars: used * 0.4, diffDollars: null, actualPct: null, expectedPct: null, pctDiff: null })),
      }) as ParsedReport;
    const avg = averagedReport([week("2026-10-07", [["COOKIES", 100], ["CHIPS", 50]]), week("2026-10-14", [["CHIPS", 70], ["COOKIES", 120], ["BROWNIE", 10]])], "wisrInventoryItems");
    if (!avg || avg.type !== "wisrInventoryItems") throw new Error("no average");
    const used = Object.fromEntries(avg.items.map((i) => [i.item, i.used]));
    expect(used).toEqual({ COOKIES: 110, CHIPS: 60, BROWNIE: 10 });
  });
});
