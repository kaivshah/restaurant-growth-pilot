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
