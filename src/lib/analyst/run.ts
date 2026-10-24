import type { OfferCandidate } from "@/lib/offers";
import type { AnalystContext } from "./context";
import { type RunLimits, runToolLoop } from "./loop";
import type { AnalystModel } from "./models";
import { ANALYST_SYSTEM, MAX_PROPOSALS, analystRequest } from "./prompt";
import { type BaselineDecision, type Finding, type Proposal, SUBMIT_SCHEMA, Submission } from "./schema";
import { DATA_TOOLS } from "./tools";
import { type ToolLog, checkFinding, checkProposal, similar } from "./verify";

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
    user: analystRequest(ctx, baseline),
    ctx,
    tools: DATA_TOOLS,
    submit: {
      name: "submit_analysis",
      description: "Submit your findings, offer proposals and decisions on the standard ideas. Call once, at the end.",
      jsonSchema: SUBMIT_SCHEMA,
      schema: Submission,
    },
    limits,
  });
  const out: AnalysisOutcome = {
    status: "FAILED",
    error: res.error,
    busy: res.busy,
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
  for (const p of sub.proposals.slice(0, MAX_PROPOSALS)) {
    const problems = checkProposal(p, ctx, log);
    const dup = taken.find((t) => similar(t, p.title));
    if (dup) problems.push(`Too similar to "${dup}".`);
    if (p.baseline_key && !baseline.some((b) => b.key === p.baseline_key)) problems.push(`There is no standard idea "${p.baseline_key}".`);
    if (problems.length) out.rejected.push({ kind: "proposal", title: p.title, reasons: problems });
    else {
      out.proposals.push(p);
      taken.push(p.title);
    }
  }

  const keys = new Set(baseline.map((b) => b.key));
  out.baselineDecisions = sub.baseline_decisions.filter((d) => keys.has(d.key));
  return { ...out, status: "DONE" };
}
