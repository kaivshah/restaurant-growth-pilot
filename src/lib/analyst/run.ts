import { type RetryOptions, withRetry } from "@/lib/llm/retry";
import type { OfferCandidate } from "@/lib/offers";
import type { AnalystContext } from "./context";
import type { AnalystModel, ToolResult } from "./models";
import { ANALYST_SYSTEM, MAX_PROPOSALS, analystRequest } from "./prompt";
import { type BaselineDecision, type Finding, type Proposal, SUBMIT_SCHEMA, Submission } from "./schema";
import { DATA_TOOLS, TOOLS_BY_NAME } from "./tools";
import { type ToolLog, checkFinding, checkProposal, similar } from "./verify";

export interface RunLimits {
  /** Most data-tool calls per run */
  maxToolCalls?: number;
  /** Most model turns per run */
  maxTurns?: number;
  /** Stop when the run has read this many input tokens in total */
  maxInputTokens?: number;
  retry?: RetryOptions;
}

export interface Rejected {
  kind: "proposal" | "finding";
  title: string;
  reasons: string[];
}

export interface AnalysisOutcome {
  status: "DONE" | "FAILED";
  error?: string;
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

const SUBMIT_TOOL = {
  name: "submit_analysis",
  description: "Submit your findings, offer proposals and decisions on the standard ideas. Call once, at the end.",
  inputSchema: SUBMIT_SCHEMA,
};

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
  const maxToolCalls = limits.maxToolCalls ?? 12;
  const maxTurns = limits.maxTurns ?? 16;
  const maxInputTokens = limits.maxInputTokens ?? 400_000;
  const log: ToolLog = [];
  const out: AnalysisOutcome = {
    status: "FAILED",
    findings: [],
    proposals: [],
    rejected: [],
    baselineDecisions: [],
    toolLog: log,
    toolCalls: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const fail = (error: string) => ({ ...out, status: "FAILED" as const, error });

  const session = model.start({
    system: ANALYST_SYSTEM,
    user: analystRequest(ctx, baseline),
    tools: [...DATA_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), SUBMIT_TOOL],
  });

  let input: Parameters<typeof session.send>[0] = null;
  let nudges = 0;
  let badSubmits = 0;

  while (out.turns < maxTurns) {
    out.turns++;
    let turn;
    try {
      const current = input;
      ({ value: turn } = await withRetry((signal) => session.send(current, signal), { timeoutMs: 120_000, ...limits.retry }));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    out.inputTokens += turn.inputTokens;
    out.outputTokens += turn.outputTokens;
    if (out.inputTokens > maxInputTokens) return fail(`Stopped at the token budget (${maxInputTokens.toLocaleString("en-US")} input tokens).`);

    if (turn.toolCalls.length === 0) {
      if (nudges >= 2) return fail("The analyst stopped without submitting an analysis.");
      nudges++;
      input = { nudge: "Please finish by calling submit_analysis with your findings, proposals and baseline decisions." };
      continue;
    }

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      if (call.name === "submit_analysis") {
        const parsed = Submission.safeParse(call.input);
        if (parsed.success) return verifySubmission(parsed.data, ctx, log, baseline, existingTitles, out);
        badSubmits++;
        if (badSubmits >= 3) return fail("The analyst's submission didn't match the required format.");
        const issues = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        results.push({ id: call.id, name: call.name, content: `Not accepted. Fix these and call submit_analysis again: ${issues}`, isError: true });
        continue;
      }
      const tool = TOOLS_BY_NAME.get(call.name);
      if (!tool) {
        results.push({ id: call.id, name: call.name, content: `There is no tool called ${call.name}.`, isError: true });
        continue;
      }
      if (out.toolCalls >= maxToolCalls) {
        results.push({ id: call.id, name: call.name, content: "Tool budget used up. Call submit_analysis now.", isError: true });
        continue;
      }
      try {
        const output = tool.run(ctx, tool.parse(call.input ?? {}));
        out.toolCalls++;
        log.push({ id: call.id, name: call.name, input: call.input, output });
        results.push({ id: call.id, name: call.name, content: JSON.stringify(output) });
      } catch (err) {
        results.push({ id: call.id, name: call.name, content: `Bad input: ${err instanceof Error ? err.message : String(err)}`, isError: true });
      }
    }
    input = results;
  }
  return fail(`Stopped after ${maxTurns} turns without a submission.`);
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
