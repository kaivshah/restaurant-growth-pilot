import { createHash } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import type { AnalystContext } from "../context";
import { type LoopResult, type RunLimits, runToolLoop } from "../loop";
import type { AnalystModel } from "../models";
import { MAX_PROPOSALS, MIN_PROPOSALS } from "../prompt";
import { prefetchFor } from "../run";
import { DATA_TOOLS } from "../tools";
import { type ToolLog, checkDiagnosisFinding, checkCalculation, checkProposal, itemKey, similar } from "../verify";
import { DIAGNOSE_ASK, PIPELINE_SYSTEM, critiqueAsk, retryStrategiseAsk, strategiseAsk } from "./prompts";
import { CRITIQUE_JSON, Critique, DIAGNOSIS_JSON, Diagnosis, type Candidate, type Finding, STRATEGY_JSON, Strategy } from "./schema";

/**
 * The offer pipeline: DIAGNOSE (what is true) → STRATEGISE (10–12 ideas) →
 * CRITIQUE (score and pick 5) → code checks → the inbox. Each stage is one
 * request; the three share a cached data prefix, so stages 2 and 3 read the
 * data at a fraction of the price. Each stage's answer is cached by the hash
 * of its inputs, so a rerun redoes only what changed. The Critique is skipped
 * when there are five or fewer candidates.
 */

export interface StageCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface PipelineOptions {
  existingTitles?: string[];
  /** What the owner asked for this time, e.g. "ideas for dinner" (phase 2) */
  steer?: string;
  cache?: StageCache;
  limits?: RunLimits;
  onStage?: (stage: "diagnose" | "strategise" | "critique" | "verify", note: string) => void | Promise<void>;
}

export interface Rejected {
  kind: "finding" | "candidate";
  title: string;
  reasons: string[];
}

export interface Stages {
  diagnosis: { findings: Finding[]; rejected: Rejected[]; cached: boolean };
  strategy: { candidates: Candidate[]; cached: boolean; retried: boolean };
  critique: { scores: Critique["scores"]; picked: string[]; cached: boolean; skipped: boolean } | null;
  verify: { accepted: string[]; rejected: Rejected[] };
}

export interface PipelineOutcome {
  status: "DONE" | "FAILED";
  error?: string;
  busy?: { retryAfterMs?: number };
  fatal?: boolean;
  findings: Finding[];
  /** The accepted candidates (a candidate is a proposal with its key and the finding it answers) */
  proposals: Candidate[];
  rejected: Rejected[];
  stages: Stages | null;
  toolLog: ToolLog;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);

export async function runPipeline(model: AnalystModel, ctx: AnalystContext, opts: PipelineOptions = {}): Promise<PipelineOutcome> {
  const usage = { toolLog: [] as ToolLog, toolCalls: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
  const fail = (res: LoopResult<unknown>, stage: string): PipelineOutcome => ({
    status: "FAILED",
    error: `${stage}: ${res.error ?? "no answer"}`,
    busy: res.busy,
    fatal: res.fatal,
    findings: [],
    proposals: [],
    rejected: [],
    stages: null,
    ...usage,
  });
  const prefetch = prefetchFor(ctx);
  const base = { system: PIPELINE_SYSTEM, user: `Restaurant: ${ctx.restaurant.name}${ctx.restaurant.kind === "FRANCHISE" && ctx.restaurant.brand ? ` (${ctx.restaurant.brand} franchise)` : ""}. Opening hours as entered: ${ctx.restaurant.openingHours ?? "not given"}.`, ctx, tools: [] as typeof DATA_TOOLS, prefetchTools: DATA_TOOLS, prefetch, oneShot: true, limits: { maxTurns: 2, ...opts.limits } };
  // The data every stage reads, for the cache keys (the prefetched results are deterministic for the same context).
  const dataKey = hash([model.provider, model.model, ctx.reports.map((r) => r.report), ctx.rules, ctx.menu.lines, ctx.pastDecisions]);

  async function stage<S>(name: string, ask: string, submit: { name: string; description: string; jsonSchema: Record<string, unknown>; schema: ZodType<S, ZodTypeDef, unknown> }) {
    const key = `stage:${name}:${hash([dataKey, ask])}`;
    const cached = (await opts.cache?.get(key)) as { submission: S; toolLog: ToolLog } | null;
    if (cached) return { res: { status: "DONE" as const, submission: cached.submission, toolLog: cached.toolLog, toolCalls: 0, turns: 0, inputTokens: 0, outputTokens: 0 } as LoopResult<S>, cached: true };
    const res = await runToolLoop<AnalystContext, S>(model, { ...base, ask, submit });
    usage.toolLog = res.toolLog.length > usage.toolLog.length ? res.toolLog : usage.toolLog;
    usage.toolCalls += res.toolCalls;
    usage.turns += res.turns;
    usage.inputTokens += res.inputTokens;
    usage.outputTokens += res.outputTokens;
    if (res.status === "DONE" && res.submission) await opts.cache?.set(key, { submission: res.submission, toolLog: res.toolLog });
    return { res, cached: false };
  }

  // 1. Diagnose
  await opts.onStage?.("diagnose", "Reading the reports for what is true…");
  const d = await stage("diagnose", DIAGNOSE_ASK, { name: "submit_diagnosis", description: "Submit the findings. Call once.", jsonSchema: DIAGNOSIS_JSON, schema: Diagnosis });
  if (d.res.status !== "DONE" || !d.res.submission) return fail(d.res, "Diagnose");
  const log = d.res.toolLog;
  const findings: Finding[] = [];
  const rejectedFindings: Rejected[] = [];
  for (const f of d.res.submission.findings) {
    const problems = checkDiagnosisFinding(f, log);
    if (problems.length) rejectedFindings.push({ kind: "finding", title: f.title, reasons: problems });
    else findings.push(f);
  }
  if (findings.length === 0) return { ...fail(d.res, "Diagnose"), error: "Diagnose: no finding passed the checks.", rejected: rejectedFindings };
  // The verified calculations become citable data for the next stages.
  const calcIds = findings.map((_, i) => `calc_${i + 1}`);
  const logWithCalcs: ToolLog = [...log, ...findings.map((f, i) => ({ id: calcIds[i], name: "diagnosis", input: {}, output: { calculations: f.calculations.map((c) => ({ label: c.label, result: c.result })) } }))];

  // 2. Strategise (with one retry when too few survive the checks)
  await opts.onStage?.("strategise", `Inventing offers from ${findings.length} findings…`);
  const ask = strategiseAsk(ctx, findings, calcIds, opts.steer);
  const s = await stage("strategise", ask, { name: "submit_strategy", description: "Submit the candidate offers. Call once.", jsonSchema: STRATEGY_JSON, schema: Strategy });
  if (s.res.status !== "DONE" || !s.res.submission) return fail(s.res, "Strategise");
  let candidates = dedupe(s.res.submission.candidates);

  // 3. Critique (skipped when there is little to choose from)
  let critique: Stages["critique"] = null;
  if (candidates.length > MAX_PROPOSALS) {
    await opts.onStage?.("critique", `Judging ${candidates.length} candidates…`);
    const c = await stage("critique", critiqueAsk(candidates, findings), { name: "submit_critique", description: "Submit the scores and the picks. Call once.", jsonSchema: CRITIQUE_JSON, schema: Critique });
    if (c.res.status !== "DONE" || !c.res.submission) return fail(c.res, "Critique");
    const scores = c.res.submission.scores.map((sc) => (sc.weekly_cost && checkCalculation(sc.weekly_cost, logWithCalcs).length ? { ...sc, weekly_cost: undefined } : sc));
    critique = { scores, picked: c.res.submission.picked.filter((k) => candidates.some((x) => x.key === k)), cached: c.cached, skipped: false };
  } else {
    critique = { scores: [], picked: candidates.map((x) => x.key), cached: false, skipped: true };
  }

  // 4. Verify: the picks first, then the critic's next-best if too few pass
  await opts.onStage?.("verify", "Checking the picks against your rules and numbers…");
  const order = [...critique.picked, ...rankedRest(candidates, critique)];
  let { accepted, rejected } = verify(order.map((k) => candidates.find((x) => x.key === k)!), ctx, logWithCalcs, opts.existingTitles ?? []);
  let retried = false;
  if (accepted.length < MIN_PROPOSALS) {
    retried = true;
    await opts.onStage?.("strategise", "Too few passed the checks: asking for different ideas…");
    const r = await stage("strategise-retry", retryStrategiseAsk(ask, accepted.map((p) => ({ title: p.title, target: p.target, item: p.item })), rejected, MAX_PROPOSALS - accepted.length), { name: "submit_strategy", description: "Submit the candidate offers. Call once.", jsonSchema: STRATEGY_JSON, schema: Strategy });
    if (r.res.status === "DONE" && r.res.submission) {
      const more = dedupe(r.res.submission.candidates, candidates).map((x) => ({ ...x, key: `r${x.key}` }));
      candidates = [...candidates, ...more];
      const second = verify(more, ctx, logWithCalcs, [...(opts.existingTitles ?? []), ...accepted.map((p) => p.title)], accepted);
      accepted = [...accepted, ...second.accepted];
      rejected = [...rejected, ...second.rejected];
    }
  }
  const proposals = accepted.slice(0, MAX_PROPOSALS);
  return {
    status: "DONE",
    findings,
    proposals,
    rejected: [...rejectedFindings, ...rejected],
    stages: {
      diagnosis: { findings, rejected: rejectedFindings, cached: d.cached },
      strategy: { candidates, cached: s.cached, retried },
      critique,
      verify: { accepted: proposals.map((p) => p.title), rejected },
    },
    toolLog: logWithCalcs,
    toolCalls: usage.toolCalls,
    turns: usage.turns,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/** Candidates not picked, best critic score first (or in order when the critic was skipped). */
function rankedRest(candidates: Candidate[], critique: NonNullable<Stages["critique"]>): string[] {
  const score = (k: string) => {
    const s = critique.scores.find((x) => x.key === k);
    return s && s.verdict !== "drop" ? s.expected_lift + s.cost_efficiency + s.fit + s.novelty : -1;
  };
  return candidates
    .map((c) => c.key)
    .filter((k) => !critique.picked.includes(k) && score(k) >= 0)
    .sort((a, b) => score(b) - score(a));
}

/** Drops near-duplicates within a batch (and against an earlier batch): a similar title for the same item. */
function dedupe(list: Candidate[], against: Candidate[] = []): Candidate[] {
  const out: Candidate[] = [];
  for (const c of list) if (![...against, ...out].some((o) => itemKey(o.item) === itemKey(c.item) && similar(o.title, c.title))) out.push(c);
  return out;
}

/** The existing proposal checks, plus one target and one item per accepted offer. */
function verify(list: Candidate[], ctx: AnalystContext, log: ToolLog, existingTitles: string[], already: Candidate[] = []) {
  const accepted: Candidate[] = [];
  const rejected: Rejected[] = [];
  const items = new Map(already.map((p) => [itemKey(p.item), p.title]));
  const targets = new Map(already.map((p) => [p.target, p.title]));
  // Ideas the owner already decided on mustn't come back under a new name; within a run, item and target keep ideas apart.
  for (const c of list) {
    const problems = checkProposal(c, ctx, log);
    const dup = existingTitles.find((t) => similar(t, c.title));
    if (dup) problems.push(`Too similar to "${dup}", which you already decided on.`);
    const sameItem = items.get(itemKey(c.item));
    if (sameItem) problems.push(`Gives away the same item as "${sameItem}"; each idea needs a different item.`);
    const sameTarget = targets.get(c.target);
    if (sameTarget) problems.push(`Fixes the same problem (${c.target}) as "${sameTarget}".`);
    if (c.for_sign_up && [...already, ...accepted].some((q) => q.for_sign_up)) problems.push("There is already a sign-up gift.");
    if (problems.length) rejected.push({ kind: "candidate", title: c.title, reasons: problems });
    else {
      accepted.push(c);
      items.set(itemKey(c.item), c.title);
      targets.set(c.target, c.title);
    }
  }
  return { accepted, rejected };
}
