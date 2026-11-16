import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReportFile, type ParsedReport } from "@/lib/reports";
import type { AnalystContext } from "../context";
import { checkCalculation, evalFormula } from "../verify";
import { fakePipeline } from "./fake";
import { runPipeline } from "./index";

async function load(dir: string, files: string[]) {
  const out: ParsedReport[] = [];
  for (const f of files) {
    const buf = readFileSync(join(dir, f));
    const r = await parseReportFile(f, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (!r.ok) throw new Error(r.message);
    out.push(r.report);
  }
  return out;
}
const SAMPLE = join(process.cwd(), "fixtures", "sample");
const FILES = ["DayPartSalesAndUnitsReport20260304.csv", "SalesSummary_00000_3-10-2026.csv", "UnitsSummary_00000_3-10-2026.csv", "AdjustedCostOfGoods_00000_3-10-2026.csv", "InventoryItems_00000_3-10-2026.csv"];
const ctxFor = (reports: ParsedReport[]): AnalystContext => ({
  restaurant: { name: "Subway #00000", kind: "FRANCHISE", brand: "Subway", radiusMiles: 3, minCateringOrder: 10, openingHours: null },
  rules: { promoApproval: "YES", maxDiscountPct: 25, allowFreeExtra: true, allowFreeDelivery: true, allowPercentOff: true, allowBogo: true, useBrandCateringMenu: true },
  reports: reports.map((report) => ({ report, status: "CONFIRMED" as const })),
  pastDecisions: [],
  menu: { priced: 0, total: 0, lines: [], items: [] },
  inventoryMap: {},
  calendar: null,
  focus: null,
});

describe("formulas the AI shows its working for", () => {
  it("evaluates plain arithmetic and refuses anything else", () => {
    expect(evalFormula("a / b * 100", { a: 25, b: 200 })).toBe(12.5);
    expect(evalFormula("(a - b) / b * 100", { a: 110, b: 100 })).toBeCloseTo(10);
    expect(evalFormula("a * 7", { a: 2.5 })).toBe(17.5);
    expect(evalFormula("a / 0", { a: 1 })).toBeNull();
    expect(evalFormula("Math.max(a, 1)", { a: 1 })).toBeNull();
    expect(evalFormula("a + c", { a: 1 })).toBeNull();
  });

  it("checks a calculation's inputs against the data and redoes the sum", () => {
    const log = [{ id: "h", name: "get_hourly_sales", input: {}, output: { rows: [{ sales: 700 }, { sales: 4200 }] } }];
    const calc = { label: "3 pm share of noon", inputs: [{ name: "a", tool_call_id: "h", field: "rows[0].sales", value: 700 }, { name: "b", tool_call_id: "h", field: "rows[1].sales", value: 4200 }], formula: "a / b * 100", result: 16.7 };
    expect(checkCalculation(calc, log)).toEqual([]);
    expect(checkCalculation({ ...calc, result: 25 }, log).join(" ")).toMatch(/gives 16.67, not 25/);
    expect(checkCalculation({ ...calc, inputs: [{ ...calc.inputs[0], value: 900 }, calc.inputs[1]] }, log).join(" ")).toMatch(/cited 900/);
  });
});

describe("the offer pipeline", () => {
  it("diagnoses, invents, critiques and verifies, caching each stage", async () => {
    const ctx = ctxFor(await load(SAMPLE, FILES));
    const store = new Map<string, unknown>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => void store.set(k, v) };
    const stages: string[] = [];
    const out = await runPipeline(fakePipeline(), ctx, { cache, onStage: (s) => void stages.push(s) });
    expect(out.status).toBe("DONE");
    // Diagnose: the invented finding is dropped, the calculation passes.
    expect(out.findings.map((f) => f.title)).toEqual(["3 pm sells a fraction of noon", "Few orders include a drink", "Late evening is quiet"]);
    expect(out.rejected.find((r) => r.title === "Invented finding")?.reasons.join(" ")).toMatch(/cited 1, but/);
    expect(out.stages?.diagnosis.findings[0].calculations[0].result).toBeGreaterThan(0);
    // Strategise + critique: 7 candidates, critic ran, picked 5, the 20% off was dropped.
    expect(out.stages?.strategy.candidates).toHaveLength(7);
    expect(out.stages?.critique?.skipped).toBe(false);
    expect(out.stages?.critique?.scores.find((s) => s.key === "c6")?.verdict).toBe("drop");
    // Verify: the picks pass (the invented-number candidate wasn't picked), 5 offers, different items and targets.
    expect(out.proposals.map((p) => p.key)).toEqual(["c1", "c2", "c3", "c4", "c7"]);
    expect(new Set(out.proposals.map((p) => p.target)).size).toBe(5);
    expect(stages).toEqual(["diagnose", "strategise", "critique", "verify"]);
    expect(out.toolLog.some((c) => c.id === "calc_1")).toBe(true);

    // A second run with the same data reads every stage from the cache: no model calls.
    const again = await runPipeline(fakePipeline(), ctx, { cache });
    expect(again.stages?.diagnosis.cached && again.stages?.strategy.cached && again.stages?.critique?.cached).toBe(true);
    expect(again.inputTokens).toBe(0);
    expect(again.proposals.map((p) => p.title)).toEqual(out.proposals.map((p) => p.title));
  });

  it("asks the strategist again when too few picks pass the checks", async () => {
    const ctx = ctxFor(await load(SAMPLE, FILES));
    ctx.rules = { ...ctx.rules, allowBogo: false, allowFreeExtra: false }; // only % off survives: nothing in the first batch does
    const out = await runPipeline(fakePipeline(), ctx, {});
    expect(out.status).toBe("DONE");
    expect(out.stages?.strategy.retried).toBe(true);
    expect(out.rejected.filter((r) => r.kind === "candidate").length).toBeGreaterThan(3);
  });
});

describe("owner voice and fresh runs", () => {
  it("puts the owner's focus and steer in the inventor's ask, and a fresh run skips the cached ideas but not the diagnosis", async () => {
    const ctx = ctxFor(await load(SAMPLE, FILES));
    ctx.focus = "Dinner is weak and we just hired an evening crew";
    const asks: string[] = [];
    const model = fakePipeline();
    const spy = { ...model, start: (o: Parameters<typeof model.start>[0]) => (asks.push(o.user), model.start(o)) };
    const store = new Map<string, unknown>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => void store.set(k, v) };
    await runPipeline(spy, ctx, { cache, steer: "ideas for Tuesdays" });
    const invent = asks.find((a) => a.startsWith("Stage: STRATEGISE"))!;
    expect(invent).toMatch(/What matters to the owner this month.*Dinner is weak/);
    expect(invent).toMatch(/For this run the owner asks: ideas for Tuesdays/);
    asks.length = 0;
    const again = await runPipeline(spy, ctx, { cache, steer: "ideas for Tuesdays", fresh: true });
    expect(again.stages?.diagnosis.cached).toBe(true);
    expect(again.stages?.strategy.cached).toBe(false);
    expect(asks.some((a) => a.startsWith("Stage: DIAGNOSE"))).toBe(false);
  });
});
