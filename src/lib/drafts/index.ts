import { createHash } from "node:crypto";
import type { DraftJob, JobKind, Prisma, Restaurant } from "@prisma/client";
import { analystFromEnv, buildContext, estimateCostUsd, mergeIdeas, proposalToOffer, runAnalysis } from "@/lib/analyst";
import type { AnalysisOutcome, AnalystContext } from "@/lib/analyst";
import { db } from "@/lib/db";
import { computeInsights } from "@/lib/insights";
import { AiBusyError, AiConfigError, type FactsPacket, type CallLog, missingAiReason, providerFromEnv, writeOfferCopy } from "@/lib/llm";
import { type OfferCandidate, buildOffers, isBrandSafe } from "@/lib/offers";
import type { ParsedReport } from "@/lib/reports";

/** Most new drafts one restaurant can get per day, to keep AI costs predictable. */
export const DAILY_DRAFT_CAP = Number(process.env.DAILY_DRAFT_CAP ?? 40);
/** Most AI rewrites per draft. */
export const REWRITE_LIMIT = 5;

export function packetFor(restaurant: Restaurant, offer: OfferCandidate): FactsPacket {
  return {
    restaurant: { name: restaurant.name, brand: restaurant.brand, kind: restaurant.kind },
    offer: { key: offer.key, title: offer.title, schedule: offer.schedule, audience: offer.audience, copyLabel: offer.copyLabel },
    facts: offer.facts,
    rules: {
      brandSafe: isBrandSafe(restaurant),
      maxDiscountPct: restaurant.maxDiscountPct,
      codePlaceholder: offer.needsCode ? "[CODE]" : null,
    },
  };
}

export function hashPacket(packet: FactsPacket, offer: OfferCandidate): string {
  return createHash("sha256").update(JSON.stringify({ packet, why: offer.why, cost: offer.cost })).digest("hex");
}

export async function logCall(restaurantId: string | null, log: CallLog | null) {
  if (!log) return;
  await db.llmCall.create({ data: { restaurantId, ...log } });
}

/** Reports the owner hasn't marked as wrong. Drafting waits until at least one is confirmed. */
export async function usableReports(restaurantId: string) {
  const rows = await db.reportUpload.findMany({
    where: { restaurantId, status: { not: "FLAGGED" } },
    orderBy: { periodEnd: "desc" },
  });
  return { rows, reports: rows.map((r) => r.data as unknown as ParsedReport), anyConfirmed: rows.some((r) => r.status === "CONFIRMED") };
}

type IdeaResult = { offers: OfferCandidate[]; analysisRunId: string | null; note: string };

/**
 * Standard rule ideas, plus the AI analyst's when ANALYST_PROVIDER is set.
 * A run is reused while the reports, rules and past decisions are unchanged,
 * so refreshing doesn't pay for the same analysis twice.
 */
async function ideasFor(restaurant: Restaurant, rows: Awaited<ReturnType<typeof usableReports>>["rows"]): Promise<IdeaResult> {
  const reports = rows.map((r) => r.data as unknown as ParsedReport);
  const baseline = buildOffers(computeInsights(reports), restaurant);
  const analyst = analystFromEnv();
  if (!analyst) return { offers: baseline, analysisRunId: null, note: "standard ideas only" };

  const decisions = await db.draft.findMany({
    where: { restaurantId: restaurant.id, kind: "CUSTOMER_OFFER", status: { in: ["APPROVED", "SKIPPED"] } },
    orderBy: { decidedAt: "desc" },
    take: 30,
  });
  const ctx: AnalystContext = buildContext(
    restaurant,
    rows.map((r) => ({ report: r.data as unknown as ParsedReport, status: r.status === "CONFIRMED" ? "CONFIRMED" : "READ" })),
    decisions.map((d) => ({ title: d.title, status: d.status as "APPROVED" | "SKIPPED", skipReason: d.skipReason, source: d.source })),
  );
  const dataHash = createHash("sha256")
    .update(
      JSON.stringify({
        analyst: `${analyst.provider}:${analyst.model}`,
        reports: rows.map((r) => [r.id, r.status]),
        rules: ctx.rules,
        restaurant: ctx.restaurant,
        decisions: decisions.map((d) => [d.id, d.status, d.skipReason]),
      }),
    )
    .digest("hex");

  const previous = await db.analysisRun.findFirst({
    where: { restaurantId: restaurant.id, purpose: "offers", dataHash, status: "DONE" },
    orderBy: { createdAt: "desc" },
  });
  if (previous) {
    const stored = previous.accepted as unknown as { offers: OfferCandidate[]; proposals: AnalysisOutcome["proposals"] } | null;
    const offers = mergeIdeas(baseline, stored?.offers ?? [], {
      proposals: stored?.proposals ?? [],
      baselineDecisions: (previous.baselineDecisions as unknown as AnalysisOutcome["baselineDecisions"]) ?? [],
    });
    return { offers, analysisRunId: previous.id, note: "reused the last analysis (data unchanged)" };
  }

  const run = await db.analysisRun.create({ data: { restaurantId: restaurant.id, provider: analyst.provider, model: analyst.model, dataHash } });
  const started = Date.now();
  // Ideas the owner already decided on shouldn't come back under a new name.
  const outcome = await runAnalysis(analyst, ctx, baseline, decisions.map((d) => d.title), {
    onTurn: (turn, lookups) => progress(restaurant.id, "OFFERS", `AI is studying your reports (step ${turn}, ${lookups} data lookups so far)…`),
  });
  if (outcome.fatal) {
    await db.analysisRun.update({ where: { id: run.id }, data: { status: "FAILED", error: outcome.error ?? null, model: analyst.model, finishedAt: new Date() } });
    await logAnalysisCall(restaurant.id, analyst, outcome, started, "analysis");
    throw new AiConfigError(outcome.error ?? "The AI provider rejected the request.");
  }
  if (outcome.busy) {
    // Not a real result: drop the run and let the job try again later.
    await db.analysisRun.delete({ where: { id: run.id } });
    await logAnalysisCall(restaurant.id, analyst, outcome, started, "analysis");
    throw new AiBusyError(outcome.error ?? "The AI analyst is busy.", outcome.busy.retryAfterMs);
  }
  const aiOffers = outcome.proposals.map((p) => proposalToOffer(p, ctx, outcome.toolLog));
  const findings = outcome.findings.map((f) => ({ title: f.title, detail: f.detail, citations: citationsFor(f.evidence, outcome) }));
  await db.analysisRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
      model: analyst.model,
      error: outcome.error ?? null,
      findings: json(findings),
      accepted: json({ offers: aiOffers, proposals: outcome.proposals }),
      rejected: json(outcome.rejected),
      baselineDecisions: json(outcome.baselineDecisions),
      toolLog: json(outcome.toolLog),
      toolCalls: outcome.toolCalls,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      estimatedCostUsd: estimateCostUsd(analyst.model, outcome.inputTokens, outcome.outputTokens),
      finishedAt: new Date(),
    },
  });
  await logAnalysisCall(restaurant.id, analyst, outcome, started, "analysis");
  if (outcome.status !== "DONE") {
    return { offers: baseline, analysisRunId: run.id, note: `analysis failed (${outcome.error}); used standard ideas` };
  }
  return {
    offers: mergeIdeas(baseline, aiOffers, outcome),
    analysisRunId: run.id,
    note: `analysis found ${outcome.findings.length} insights, ${outcome.proposals.length} offers (${outcome.rejected.length} rejected by checks)`,
  };
}

function citationsFor(evidence: AnalysisOutcome["findings"][number]["evidence"], outcome: AnalysisOutcome) {
  return evidence.map((e) => {
    const out = outcome.toolLog.find((c) => c.id === e.tool_call_id)?.output as { source?: string | string[] } | undefined;
    const source = Array.isArray(out?.source) ? out.source.join("; ") : (out?.source ?? "Your reports");
    return { label: e.label, value: e.value, source };
  });
}

export async function logAnalysisCall(
  restaurantId: string,
  analyst: { provider: string; model: string },
  outcome: { status: string; turns: number; inputTokens: number; outputTokens: number; error?: string },
  started: number,
  purpose: string,
) {
  await db.llmCall.create({
    data: {
      restaurantId,
      provider: analyst.provider,
      model: analyst.model,
      purpose,
      outcome: outcome.status === "DONE" ? "ok" : "error",
      attempts: outcome.turns,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      durationMs: Date.now() - started,
      error: outcome.error ?? null,
    },
  });
}

export const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export async function draftsToday(restaurantId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.draft.count({ where: { restaurantId, createdAt: { gte: start } } });
}

/** Builds offer drafts for one restaurant. Returns a short summary for the job record. */
export async function buildDraftsFor(restaurantId: string): Promise<string> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return "Restaurant not found.";
  const { rows, anyConfirmed } = await usableReports(restaurantId);
  if (!anyConfirmed) return "Waiting for confirmed reports.";

  const provider = providerFromEnv();
  if (!provider) return `AI not set up. ${missingAiReason()}`;
  const { offers, analysisRunId, note } = await ideasFor(restaurant, rows);
  let created = 0;
  let reused = 0;
  const failed: string[] = [];

  for (const [i, offer] of offers.entries()) {
    const packet = packetFor(restaurant, offer);
    const factsHash = hashPacket(packet, offer);
    if (await db.draft.findUnique({ where: { restaurantId_factsHash: { restaurantId, factsHash } } })) {
      reused++;
      continue;
    }
    if ((await draftsToday(restaurantId)) >= DAILY_DRAFT_CAP) {
      return `Created ${created}; stopped at the daily limit of ${DAILY_DRAFT_CAP} drafts. ${note}.`;
    }

    await progress(restaurantId, "OFFERS", `Writing offer ${i + 1} of ${offers.length}: ${offer.title}`);
    const copy = await writeOfferCopy(provider, packet);
    await logCall(restaurantId, copy.log);
    if (!copy.ok) {
      if (copy.fatal) throw new AiConfigError(copy.message);
      if (copy.retryable) throw new AiBusyError(copy.message, copy.retryAfterMs);
      failed.push(`${offer.title}: ${copy.message}`);
      continue;
    }

    // A newer version of the same idea replaces any copy still waiting for review.
    await db.draft.deleteMany({ where: { restaurantId, offerKey: offer.key, status: "PENDING" } });
    await db.draft.create({
      data: {
        restaurantId,
        kind: "CUSTOMER_OFFER",
        offerKey: offer.key,
        source: offer.source,
        confidence: offer.confidence,
        analysisRunId: offer.source === "AI_ANALYST" ? analysisRunId : null,
        facts: offer.facts,
        needsCode: offer.needsCode,
        category: offer.category,
        title: offer.title,
        schedule: offer.schedule,
        why: offer.why,
        audience: offer.audience,
        cost: offer.cost,
        measure: offer.measure,
        checks: offer.checks,
        evidence: (offer.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
        copyLabel: offer.copyLabel,
        headline: copy.copy.headline,
        body: copy.copy.body,
        writtenBy: copy.writtenBy,
        factsHash,
      },
    });
    created++;
  }
  // Standard ideas the analyst dropped leave the inbox if they were still waiting.
  const keys = offers.map((o) => o.key);
  const removed = await db.draft.deleteMany({ where: { restaurantId, kind: "CUSTOMER_OFFER", status: "PENDING", offerKey: { notIn: keys } } });
  return `Created ${created}, unchanged ${reused}${removed.count ? `, removed ${removed.count}` : ""}${failed.length ? `, ${failed.length} not written (${failed.join("; ")})` : ""}; ${note}.`;
}

/**
 * Queue offer drafting or an area scan for a restaurant, unless the same kind
 * is already waiting. force makes a LEADS job search the area again even if
 * the last scan is recent.
 */
export async function enqueueDraftJob(restaurantId: string, kind: JobKind = "OFFERS", force = false, options?: { web?: boolean }) {
  const waiting = await db.draftJob.findFirst({ where: { restaurantId, kind, status: "QUEUED" } });
  const payload = options?.web ? { web: true } : undefined;
  // Asking again means "try now", even if the job was waiting for the AI.
  if (waiting) return db.draftJob.update({ where: { id: waiting.id }, data: { force: waiting.force || force, runAfter: null, ...(payload ? { payload } : {}) } });
  return db.draftJob.create({ data: { restaurantId, kind, force, payload } });
}

/**
 * Shows what a running job is doing: saved as the job's message (the inbox
 * and leads pages show it) and printed in the server terminal.
 */
export async function progress(restaurantId: string, kind: JobKind, text: string) {
  const label = { LEADS: "scan", SUGGEST: "suggest", PITCH: "pitch", FOLLOWUPS: "follow-ups", OFFERS: "offers" }[kind];
  console.log(`[${label}] ${text}`);
  await db.draftJob.updateMany({ where: { restaurantId, kind, status: "RUNNING" }, data: { message: text } });
}

const draining = new Set<string>();

/**
 * Jobs that call the AI run one at a time per restaurant (across all servers
 * and workers), most urgent first: a pitch the owner is waiting for, then AI
 * suggestions, follow-ups and offer ideas. Running them side by side only
 * made them queue for the same per-minute limit and time out together.
 */
export const AI_LANE: JobKind[] = ["PITCH", "SUGGEST", "FOLLOWUPS", "OFFERS"];

/**
 * Processes queued jobs. Area scans (Google and event APIs) run beside the AI
 * lane. Safe to call often: a second call while a lane is draining returns
 * straight away, and each job is claimed atomically so two servers can't run
 * the same one.
 */
export async function processDraftJobs(maxJobs = 20) {
  await Promise.all([drain(["LEADS"], maxJobs), drain(AI_LANE, maxJobs)]);
  // Sending and reply checks ride along with every pass.
  await (await import("@/lib/outreach")).runOutreach();
}

/**
 * Called by pages and actions after a request. With a separate worker
 * (`npm run worker`, and JOBS_IN_WEB="false" on the web servers) the web
 * process only queues work and returns at once.
 */
export function kickJobs() {
  if (process.env.JOBS_IN_WEB === "false") return Promise.resolve();
  return processDraftJobs();
}

/**
 * Claims the oldest runnable job of one kind. FOR UPDATE SKIP LOCKED lets any
 * number of workers claim jobs at the same time without taking the same one,
 * and a restaurant never has two jobs of one lane running at once.
 */
async function claimNext(kind: JobKind, lane: JobKind[]): Promise<DraftJob | null> {
  const rows = await db.$queryRaw<DraftJob[]>`
    UPDATE "DraftJob" SET status = 'RUNNING', "startedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM "DraftJob" j
      WHERE j.kind = ${kind}::"JobKind" AND j.status = 'QUEUED' AND (j."runAfter" IS NULL OR j."runAfter" <= now())
        AND NOT EXISTS (SELECT 1 FROM "DraftJob" r WHERE r."restaurantId" = j."restaurantId" AND r.kind::text = ANY(${lane}::text[]) AND r.status = 'RUNNING')
      ORDER BY j."createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

export type PitchTarget = { leadId?: string; eventId?: string };

/**
 * Queue pitches the owner asked for. Targets join a PITCH job that hasn't
 * started yet, so several clicks become one batch (one AI request for many
 * pitches). Returns at once; a worker writes the pitches.
 */
export async function enqueuePitches(restaurantId: string, targets: PitchTarget[]) {
  const waiting = await db.draftJob.findFirst({ where: { restaurantId, kind: "PITCH", status: "QUEUED" } });
  const key = (t: PitchTarget) => `${t.leadId ?? ""}|${t.eventId ?? ""}`;
  if (waiting) {
    const merged = [...((waiting.payload as PitchTarget[] | null) ?? []), ...targets];
    const unique = [...new Map(merged.map((t) => [key(t), t])).values()];
    return db.draftJob.update({ where: { id: waiting.id }, data: { payload: unique, runAfter: null } });
  }
  return db.draftJob.create({ data: { restaurantId, kind: "PITCH", payload: targets } });
}

/** Queue follow-up writing for approved pitches; joins a waiting batch like pitches do. */
export async function enqueueFollowUps(restaurantId: string, draftIds: string[]) {
  const waiting = await db.draftJob.findFirst({ where: { restaurantId, kind: "FOLLOWUPS", status: "QUEUED" } });
  if (waiting) {
    const merged = [...new Set([...((waiting.payload as string[] | null) ?? []), ...draftIds])];
    return db.draftJob.update({ where: { id: waiting.id }, data: { payload: merged } });
  }
  return db.draftJob.create({ data: { restaurantId, kind: "FOLLOWUPS", payload: draftIds } });
}

/** Targets in PITCH jobs that are waiting or running, for "Writing…" on the page. */
export async function pitchesInProgress(restaurantId: string): Promise<Set<string>> {
  const jobs = await db.draftJob.findMany({ where: { restaurantId, kind: "PITCH", status: { in: ["QUEUED", "RUNNING"] } }, select: { payload: true } });
  return new Set(jobs.flatMap((j) => ((j.payload as PitchTarget[] | null) ?? []).map((t) => t.eventId ?? t.leadId ?? "")));
}

/** Claims the most urgent runnable job in a lane. */
async function claimInLane(lane: JobKind[]) {
  for (const kind of lane) {
    const job = await claimNext(kind, lane);
    if (job) return job;
  }
  return null;
}

async function drain(lane: JobKind[], maxJobs: number) {
  const key = lane.join(",");
  if (draining.has(key)) return;
  draining.add(key);
  try {
    for (let i = 0; i < maxJobs; i++) {
      const next = await claimInLane(lane);
      if (!next) return;
      try {
        const leads = next.kind === "OFFERS" ? null : await import("@/lib/leads");
        const message =
          next.kind === "LEADS"
            ? await leads!.scanArea(next.restaurantId, { force: next.force, web: (next.payload as { web?: boolean } | null)?.web })
            : next.kind === "SUGGEST"
              ? await leads!.suggestLeads(next.restaurantId)
              : next.kind === "PITCH"
                ? await leads!.generatePitches(next.restaurantId, (next.payload as PitchTarget[] | null) ?? [])
                : next.kind === "FOLLOWUPS"
                  ? await (await import("@/lib/outreach")).writeFollowUps(next.restaurantId, (next.payload as string[] | null) ?? [])
                  : await buildDraftsFor(next.restaurantId);
        await db.draftJob.update({ where: { id: next.id }, data: { status: "DONE", message, finishedAt: new Date(), runAfter: null } });
      } catch (err) {
        if (err instanceof AiBusyError) {
          await db.draftJob.update({ where: { id: next.id }, data: retryLater(next.attempts, err) });
          continue;
        }
        await db.draftJob.update({
          where: { id: next.id },
          data: { status: "FAILED", message: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
        });
      }
    }
  } finally {
    draining.delete(key);
  }
}

/** Waits between tries while the AI is busy: 2, 5, 10, 20, 30 and 60 minutes. */
export const RETRY_MINUTES = [2, 5, 10, 20, 30, 60];

/** The job update after an AI-busy failure: back in the queue with a wait, or failed after the last try. */
export function retryLater(attempts: number, err: AiBusyError, now = new Date()) {
  if (attempts > RETRY_MINUTES.length) {
    return { status: "FAILED" as const, message: `The AI stayed busy after ${attempts} tries: ${err.message}`, finishedAt: now, runAfter: null };
  }
  const waitMs = Math.min(24 * 3_600_000, Math.max(RETRY_MINUTES[attempts - 1] * 60_000, err.retryAfterMs ?? 0));
  // force is cleared so a waiting area scan doesn't search Google again on the retry.
  return { status: "QUEUED" as const, startedAt: null, force: false, message: `AI busy: ${err.message}`, runAfter: new Date(now.getTime() + waitMs) };
}

/** Jobs left RUNNING by a crash or restart go back in the queue after 10 minutes. */
export async function requeueStaleJobs() {
  await db.draftJob.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "QUEUED", startedAt: null },
  });
}

/** What a page should show for a restaurant's latest job of one kind. */
export function jobState(job: { status: string; runAfter: Date | null } | null, now = new Date()): "idle" | "working" | "waiting" {
  if (!job || (job.status !== "QUEUED" && job.status !== "RUNNING")) return "idle";
  return job.status === "QUEUED" && job.runAfter && job.runAfter > now ? "waiting" : "working";
}
