import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReportFile, summarise } from "./index";
import type { ParsedReport } from "./types";

const SAMPLE = join(process.cwd(), "fixtures", "sample");
const PRIVATE = join(process.cwd(), "fixtures", "private");

async function load(dir: string, file: string) {
  const buf = readFileSync(join(dir, file));
  return parseReportFile(file, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

async function report<T extends ParsedReport["type"]>(dir: string, file: string, type: T) {
  const result = await load(dir, file);
  if (!result.ok) throw new Error(`${file}: ${result.message}`);
  expect(result.report.type).toBe(type);
  return result.report as Extract<ParsedReport, { type: T }>;
}

describe("sample reports", () => {
  it("reads the day-part report", async () => {
    const r = await report(SAMPLE, "DayPartSalesAndUnitsReport20260304.csv", "dayPart");
    expect(r.storeNumber).toBe("00000");
    expect(r.period).toEqual({ start: "2026-03-04", end: "2026-03-10" });
    expect(r.days).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
    expect(r.hours).toHaveLength(24);
    const noon = r.hours.find((h) => h.label === "12PM")!;
    expect(noon.hour24).toBe(12);
    expect(noon.byDay[0].sales).toBe(720);
    const hourSum = r.hours.reduce((s, h) => s + h.week.sales, 0);
    expect(r.weekTotal.sales).toBeCloseTo(hourSum, 2);
    expect(r.dayTotals[0].sales).toBe(4092);
  });

  it("reads the WISR sales, units and discount reports", async () => {
    const sales = await report(SAMPLE, "SalesSummary_00000_3-10-2026.csv", "wisrSales");
    expect(sales.period).toEqual({ start: "2026-03-04", end: "2026-03-10" });
    expect(sales.netSales).toBe(6250);
    expect(sales.cateringSales).toBe(250);
    expect(sales.royalty).toBe(500);

    const units = await report(SAMPLE, "UnitsSummary_00000_3-10-2026.csv", "wisrUnits");
    expect(units.customers).toBe(450);
    expect(units.drinkPct).toBe(50);
    expect(units.averageTicket).toBe(12.5);
    expect(units.catering.sandwichPlatters).toEqual({ qty: 2, dollars: 150 });

    const cogs = await report(SAMPLE, "AdjustedCostOfGoods_00000_3-10-2026.csv", "wisrAdjCogs");
    expect(cogs.totalDiscounts).toEqual({ qty: 240, dollars: 1000 });
    expect(cogs.discountPctOfSales).toBe(16);
  });

  it("reads inventory and bread reports", async () => {
    const cats = await report(SAMPLE, "InventoryCategoriesSummary_00000_3-10-2026.csv", "wisrInventoryCategories");
    expect(cats.categories.find((c) => c.category === "VEGGIES")?.diffDollars).toBe(-80);

    const items = await report(SAMPLE, "InventoryItems_00000_3-10-2026.csv", "wisrInventoryItems");
    const cheese = items.items.find((i) => i.item === "Cheese, Sliced cheese")!;
    expect(cheese.isSubtotal).toBe(false);
    expect(cheese.unitCost).toBe(2.5);
    expect(items.items.find((i) => i.item === "Cheese Sub Total")?.isSubtotal).toBe(true);

    const bread = await report(SAMPLE, "DailyCashBreadOverShort_00000_3-10-2026.csv", "wisrBreadOverShort");
    expect(bread.days).toHaveLength(7);
    expect(bread.days.find((d) => d.day === "Sun")?.bread).toBe(100);
    expect(bread.total).toEqual({ cash: 0, bread: 173 });
  });

  it("refuses files with employee names", async () => {
    const result = await load(SAMPLE, "LaborHoursbyEmployee.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
  });

  it("explains PDFs and unknown files", async () => {
    const pdf = await parseReportFile("Sept.pdf", new ArrayBuffer(4));
    expect(pdf.ok).toBe(false);
    const unknown = await parseReportFile("notes.csv", new TextEncoder().encode("a,b\n1,2").buffer);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unrecognised");
  });

  it("summarises one week for the owner to confirm", async () => {
    const reports = [
      await report(SAMPLE, "SalesSummary_00000_3-10-2026.csv", "wisrSales"),
      await report(SAMPLE, "UnitsSummary_00000_3-10-2026.csv", "wisrUnits"),
      await report(SAMPLE, "AdjustedCostOfGoods_00000_3-10-2026.csv", "wisrAdjCogs"),
    ];
    const s = summarise(reports);
    expect(s.numbers.map((n) => [n.key, n.display])).toEqual([
      ["netSales", "$6,250"],
      ["customers", "450"],
      ["averageTicket", "$12.50"],
      ["drinkPct", "50%"],
      ["discounts", "$1,000 · 16%"],
      ["cateringSales", "$250"],
    ]);
  });
});

// The real pilot reports live in fixtures/private (git-ignored). These run only where they exist.
const hasPrivate = existsSync(PRIVATE) && readdirSync(PRIVATE).some((f) => f.endsWith(".csv"));

describe.runIf(hasPrivate)("pilot store reports (private)", () => {
  it("matches the numbers we read by hand", async () => {
    const sales = await report(PRIVATE, "SalesSummary_32105_8-18-2026.csv", "wisrSales");
    const units = await report(PRIVATE, "UnitsSummary_32105_8-18-2026.csv", "wisrUnits");
    const cogs = await report(PRIVATE, "AdjustedCostOfGoods_32105_8-18-2026.csv", "wisrAdjCogs");
    expect(sales.storeNumber).toBe("32105");
    expect(sales.period).toEqual({ start: "2026-08-12", end: "2026-08-18" });
    expect(sales.netSales).toBe(8579);
    expect(sales.cateringSales).toBe(0);
    expect(units.customers).toBe(631);
    expect(units.averageTicket).toBe(13.6);
    expect(units.drinkPct).toBe(38);
    expect(cogs.totalDiscounts.dollars).toBe(2153);
    expect(cogs.discountPctOfSales).toBe(25.1);

    const day = await report(PRIVATE, "DayPartSalesAndUnitsReport20260826.csv", "dayPart");
    expect(day.storeNumber).toBe("32105");
    expect(day.period).toEqual({ start: "2026-08-26", end: "2026-09-01" });
    expect(day.weekTotal.sales).toBe(7621.47);
    expect(day.weekTotal.customers).toBe(606);
    expect(day.hours.find((h) => h.label === "12PM")?.week.sales).toBe(1142.68);
    expect(day.dayTotals[0].sales).toBe(1282.43);

    const bread = await report(PRIVATE, "DailyCashBreadOverShort_32105_8-18-2026.csv", "wisrBreadOverShort");
    expect(bread.days.find((d) => d.day === "Sun")?.bread).toBe(743);
  });
});
