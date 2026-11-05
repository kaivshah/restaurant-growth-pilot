import type { OfferCandidate } from "@/lib/offers";
import type { AnalystContext } from "./context";
import { type RunLimits, runToolLoop } from "./loop";
import type { AnalystModel } from "./models";
import { ANALYST_SYSTEM, MAX_PROPOSALS, analystRequest } from "./prompt";
import { type BaselineDecision, type Finding, type Proposal, SUBMIT_SCHEMA, Submission } from "./schema";
import { DATA_TOOLS } from "./tools";
import { type ToolLog, checkFinding, checkProposal, itemKey, similar } from "./verify";

export type { RunLimits } from "./loop";

export interface Rejected {
  kind: "proposal" | "finding";
  title: string;
  reasons: string[];
}

export interface AnalysisOutcome {
  status: "DONE" | "FAILED";
  error?: string;
  busy?: { retryAfterMs?: number };
  fatal?: boolean;
  findings: Finding[];
  proposals: Proposal[];
  rejected: Rejected[];
  baselineDecisions: BaselineDecision[];
  toolLog: ToolLog;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The lookups sent with the first request, so most runs need one AI request:
 * everything the uploaded reports can answer, and nothing they can't.
 */
export function prefetchFor(ctx: AnalystContext): { name: string }[] {
  const has = (t: string) => ctx.reports.some((r) => r.report.type === t);
  return [
    { name: "list_reports" },
    { name: "get_rules" },
    { name: "get_week_summary" },
    ...(has("dayPart") ? [{ name: "get_hourly_sales" }, { name: "get_day_totals" }] : []),
    { name: "get_weekly_trend" },
    ...(has("wisrUnits") || has("wisrInventoryItems") ? [{ name: "get_sales_mix" }] : []),
    ...(has("wisrAdjCogs") ? [{ name: "get_discount_breakdown" }] : []),
    ...(has("wisrInventoryCategories") || has("wisrInventoryItems") ? [{ name: "get_inventory_usage" }] : []),
    ...(has("wisrBreadOverShort") ? [{ name: "get_bread_over_short" }] : []),
    ...(has("cashInWeek") ? [{ name: "get_daily_sales" }] : []),
    { name: "get_past_decisions" },
  ];
}

/**
 * Lets the AI explore the store's data with read-only tools, then checks
 * everything it submits. Only verified findings and proposals come back.
 */
export async function runAnalysis(
  model: AnalystModel,
  ctx: AnalystContext,
  baseline: OfferCandidate[],
  existingTitles: string[] = [],
  limits: RunLimits = {},
): Promise<AnalysisOutcome> {
  const res = await runToolLoop(model, {
    system: ANALYST_SYSTEM,
    user: analystRequest(ctx),
    ctx,
    tools: DATA_TOOLS,
    // The usual first lookups, sent with the request so most runs need one AI request.
    prefetch: prefetchFor(ctx),
    submit: {
      name: "submit_analysis",
      description: "Submit your findings and offer proposals. Call once, at the end.",
      jsonSchema: SUBMIT_SCHEMA,
      schema: Submission,
    },
    limits,
  });
  const out: AnalysisOutcome = {
    status: "FAILED",
    error: res.error,
    busy: res.busy,
    fatal: res.fatal,
    findings: [],
    proposals: [],
    rejected: [],
    baselineDecisions: [],
    toolLog: res.toolLog,
    toolCalls: res.toolCalls,
    turns: res.turns,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };
  if (res.status !== "DONE" || !res.submission) return out;
  return verifySubmission(res.submission, ctx, res.toolLog, baseline, existingTitles, out);
}

function verifySubmission(
  sub: Submission,
  ctx: AnalystContext,
  log: ToolLog,
  baseline: OfferCandidate[],
  existingTitles: string[],
  out: AnalysisOutcome,
): AnalysisOutcome {
  for (const f of sub.findings) {
    const problems = checkFinding(f, log);
    if (problems.length) out.rejected.push({ kind: "finding", title: f.title, reasons: problems });
    else out.findings.push(f);
  }

  const taken = [...existingTitles];
  const items = new Map<string, string>();
  const targets = new Map<string, string>();
  for (const p of sub.proposals.slice(0, MAX_PROPOSALS)) {
    const problems = checkProposal(p, ctx, log);
    const dup = taken.find((t) => similar(t, p.title));
    if (dup) problems.push(`Too similar to "${dup}".`);
    if (p.baseline_key && !baseline.some((b) => b.key === p.baseline_key)) problems.push(`There is no standard idea "${p.baseline_key}".`);
    const sameItem = items.get(itemKey(p.item));
    if (sameItem) problems.push(`Gives away the same item as "${sameItem}"; each idea needs a different item.`);
    const sameTarget = targets.get(p.target);
    if (sameTarget) problems.push(`Fixes the same problem (${p.target}) as "${sameTarget}".`);
    if (problems.length) out.rejected.push({ kind: "proposal", title: p.title, reasons: problems });
    else {
      out.proposals.push(p);
      taken.push(p.title);
      items.set(itemKey(p.item), p.title);
      targets.set(p.target, p.title);
    }
  }

  const keys = new Set(baseline.map((b) => b.key));
  out.baselineDecisions = sub.baseline_decisions.filter((d) => keys.has(d.key));
  return { ...out, status: "DONE" };
}
