import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeInsights } from "@/lib/insights";
import { buildOffers } from "@/lib/offers";
import { parseReportFile, type ParsedReport } from "@/lib/reports";
import type { AnalystContext } from "./context";
import { fakeAnalyst } from "./fake";
import { mergeIdeas, proposalToOffer, runAnalysis } from "./index";
import type { AnalystModel } from "./models";
import type { Proposal } from "./schema";
import { TOOLS_BY_NAME } from "./tools";
import { checkEvidence, checkProposal, checkTextNumbers, readPath, similar, type ToolLog } from "./verify";

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
const SAMPLE_FILES = [
  "DayPartSalesAndUnitsReport20260304.csv",
  "SalesSummary_00000_3-10-2026.csv",
  "UnitsSummary_00000_3-10-2026.csv",
  "AdjustedCostOfGoods_00000_3-10-2026.csv",
  "InventoryCategoriesSummary_00000_3-10-2026.csv",
  "InventoryItems_00000_3-10-2026.csv",
  "DailyCashBreadOverShort_00000_3-10-2026.csv",
];

function ctxFor(reports: ParsedReport[], rules: Partial<AnalystContext["rules"]> = {}): AnalystContext {
  return {
    restaurant: { name: "Subway #00000", kind: "FRANCHISE", brand: "Subway", radiusMiles: 3, minCateringOrder: 10, openingHours: null },
    rules: {
      promoApproval: "UNSURE",
      maxDiscountPct: 15,
      allowFreeExtra: true,
      allowFreeDelivery: true,
      allowPercentOff: true,
      allowBogo: false,
      useBrandCateringMenu: true,
      ...rules,
    },
    reports: reports.map((report) => ({ report, status: "CONFIRMED" as const })),
    pastDecisions: [],
  };
}

const run = (ctx: AnalystContext, name: string, input: unknown = {}) => {
  const t = TOOLS_BY_NAME.get(name)!;
  return t.run(ctx, t.parse(input)) as Record<string, unknown>;
};

describe("data tools", () => {
  it("answer questions about the sample store", async () => {
    const ctx = ctxFor(await load(SAMPLE, SAMPLE_FILES));
    expect((run(ctx, "list_reports").reports as unknown[]).length).toBe(7);
    const week = run(ctx, "get_week_summary");
    expect(week.net_sales).toBe(6250);
    expect(week.drink_attach_pct).toBe(50);
    expect(week.average_drink_price).toBe(2.67);
    expect(week).not.toHaveProperty("rent");

    const hourly = run(ctx, "get_hourly_sales");
    const parts = hourly.day_parts as { part: string; share_pct: number }[];
    expect(parts.map((p) => p.part)).toContain("lunch (11 am–2 pm)");
    const sat = run(ctx, "get_hourly_sales", { day: "Sat" });
    expect(sat.day).toBe("Sat");

    expect(run(ctx, "get_bread_over_short").total_bread).toBe(173);
    expect((run(ctx, "get_item_costs", { items: ["chips"] }).items as { unit_cost: number }[])[0].unit_cost).toBe(0.7);
    expect(run(ctx, "estimate_offer_cost", { mechanic: "free_item", value_usd: 2.5 })).toMatchObject({ value_pct_of_ticket: 20, within_limit: false });
    expect(run(ctx, "get_rules")).toMatchObject({ max_discount_pct: 15, brand_safe_mode: true });
    expect(run(ctx, "compare_weeks", { metric: "net_sales", week_a: "2026-03-10", week_b: "2026-03-10" })).toMatchObject({ change: 0 });
  });

  it("report missing data instead of guessing", () => {
    const ctx = ctxFor([]);
    expect(run(ctx, "get_hourly_sales")).toHaveProperty("error");
    expect(run(ctx, "get_week_summary")).toHaveProperty("error");
  });
});

describe("checks on what the AI submits", () => {
  const log: ToolLog = [{ id: "t1", name: "get_week_summary", input: {}, output: { source: "x", drink_attach_pct: 38, rows: [{ sales: 711.05 }] } }];

  it("reads values by path and catches invented citations", () => {
    expect(readPath(log[0].output, "rows[0].sales")).toBe(711.05);
    expect(checkEvidence([{ tool_call_id: "t1", field: "drink_attach_pct", value: 38, label: "Drinks" }], log)).toEqual([]);
    expect(checkEvidence([{ tool_call_id: "t1", field: "drink_attach_pct", value: 45, label: "Drinks" }], log)[0]).toMatch(/returned 38/);
    expect(checkEvidence([{ tool_call_id: "nope", field: "x", value: 1, label: "X" }], log)[0]).toMatch(/never happened/);
  });

  it("rejects numbers in the text that aren't in the data", () => {
    expect(checkTextNumbers("Only 38% of orders include a drink", log)).toEqual([]);
    expect(checkTextNumbers("Sales fell 27% last week", log)[0]).toMatch(/27%/);
  });

  it("enforces brand rules, the discount limit and opening hours", async () => {
    const reports = await load(SAMPLE, SAMPLE_FILES);
    const ctx = ctxFor(reports);
    const hourly = run(ctx, "get_hourly_sales");
    const tlog: ToolLog = [{ id: "h", name: "get_hourly_sales", input: {}, output: hourly }];
    const base: Proposal = {
      title: "Free cookie with any footlong, 7–9 pm",
      mechanic: "free_item",
      item: "cookie",
      qualifying_purchase: "any footlong",
      value_usd: 1,
      days: ["Mon", "Tue"],
      start_hour: 19,
      end_hour: 21,
      duration_weeks: 2,
      audience: "email_list",
      why: "Evenings are quieter.",
      expected_effect: "More evening orders.",
      confidence: "medium",
      evidence: [{ tool_call_id: "h", field: "total_sales", value: hourly.total_sales as number, label: "Week sales" }],
    };
    expect(checkProposal(base, ctx, tlog)).toEqual([]);
    expect(checkProposal({ ...base, value_usd: 3 }, ctx, tlog).join(" ")).toMatch(/over the 15% limit/);
    expect(checkProposal({ ...base, mechanic: "percent_off", percent_off: 10 }, ctx, tlog).join(" ")).toMatch(/brand allows/);
    expect(checkProposal({ ...base, start_hour: 5, end_hour: 7 }, ctx, tlog).join(" ")).toMatch(/outside the hours/);
    expect(checkProposal(base, ctxFor(reports, { allowFreeExtra: false }), tlog).join(" ")).toMatch(/free extras/);
    // With brand approval, a 10% offer is fine but 20% is not.
    const open = ctxFor(reports, { promoApproval: "YES" });
    expect(checkProposal({ ...base, mechanic: "percent_off", percent_off: 10, value_usd: undefined }, open, tlog)).toEqual([]);
    expect(checkProposal({ ...base, mechanic: "percent_off", percent_off: 20, value_usd: undefined }, open, tlog).join(" ")).toMatch(/over the 15% limit/);
  });

  it("spots near-duplicate titles", () => {
    expect(similar("Free cookie with any footlong", "Free cookie with footlong after 7")).toBe(true);
    expect(similar("Free cookie with any footlong", "Weekend chips deal")).toBe(false);
  });
});

describe("a full analyst run (scripted model)", () => {
  it("explores, keeps what passes the checks and rejects the rest", async () => {
    const ctx = ctxFor(await load(SAMPLE, SAMPLE_FILES));
    const baseline = buildOffers(computeInsights(ctx.reports.map((r) => r.report)), ctx.rules);
    const out = await runAnalysis(fakeAnalyst(), ctx, baseline);
    expect(out.status).toBe("DONE");
    expect(out.toolCalls).toBe(4);
    expect(out.findings).toHaveLength(1);
    expect(out.proposals.map((p) => p.title)).toEqual(["Free cookie with any footlong, 7–9 pm"]);
    const rejected = out.rejected.find((r) => r.title.startsWith("20% off"))!;
    expect(rejected.reasons.join(" ")).toMatch(/returned/); // invented 99999
    expect(rejected.reasons.join(" ")).toMatch(/brand allows/);

    const offer = proposalToOffer(out.proposals[0], ctx, out.toolLog);
    expect(offer).toMatchObject({ source: "AI_ANALYST", confidence: "medium", schedule: "Mon–Thu, 7–9 pm · for 3 weeks", needsCode: true });
    expect(offer.evidence?.kind).toBe("citations");

    const merged = mergeIdeas(baseline, [offer], out);
    expect(merged.map((o) => o.key)).toEqual(["welcome", "afternoon-drink", "ai-free-cookie-with-any-footlong-7-9-pm"]);
  });

  it("enforces the tool budget and fails cleanly when the model never submits", async () => {
    const ctx = ctxFor(await load(SAMPLE, SAMPLE_FILES));
    let n = 0;
    const chatty: AnalystModel = {
      provider: "test",
      model: "loop",
      start: () => ({
        send: async () => ({ toolCalls: [{ id: `c${++n}`, name: "list_reports", input: {} }], text: "", inputTokens: 10, outputTokens: 5 }),
      }),
    };
    const out = await runAnalysis(chatty, ctx, [], [], { maxToolCalls: 3, maxTurns: 6 });
    expect(out.status).toBe("FAILED");
    expect(out.toolCalls).toBe(3);
  });

  it("asks the model to fix a malformed submission", async () => {
    const ctx = ctxFor(await load(SAMPLE, SAMPLE_FILES));
    let n = 0;
    const sloppy: AnalystModel = {
      provider: "test",
      model: "sloppy",
      start: () => ({
        send: async (input) => {
          n++;
          if (n === 1) return { toolCalls: [{ id: "s1", name: "submit_analysis", input: { findings: "none" } }], text: "", inputTokens: 1, outputTokens: 1 };
          expect(Array.isArray(input) && input[0].isError).toBe(true);
          return { toolCalls: [{ id: "s2", name: "submit_analysis", input: { findings: [], proposals: [], baseline_decisions: [] } }], text: "", inputTokens: 1, outputTokens: 1 };
        },
      }),
    };
    expect((await runAnalysis(sloppy, ctx, [])).status).toBe("DONE");
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

describe.runIf(PRIVATE_FILES.every((f) => existsSync(join(PRIVATE, f))))("pilot store (private)", () => {
  it("gives the analyst the real numbers", async () => {
    const ctx = ctxFor(await load(PRIVATE, PRIVATE_FILES));
    expect(run(ctx, "get_week_summary")).toMatchObject({ net_sales: 8579, customers: 631, average_ticket: 13.6, drink_attach_pct: 38, discounts_pct_of_sales: 25.1 });
    expect(run(ctx, "get_hourly_sales").total_sales).toBe(7621.47);
    expect(run(ctx, "estimate_offer_cost", { mechanic: "free_item", value_usd: 2.5 })).toMatchObject({ value_pct_of_ticket: 18.4, within_limit: false });
    const out = await runAnalysis(fakeAnalyst(), ctx, []);
    expect(out.status).toBe("DONE");
    expect(out.proposals).toHaveLength(1);
  });
});
