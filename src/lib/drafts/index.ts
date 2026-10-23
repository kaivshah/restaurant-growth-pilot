import { createHash } from "node:crypto";
import type { Prisma, Restaurant } from "@prisma/client";
import { analystFromEnv, buildContext, estimateCostUsd, mergeIdeas, proposalToOffer, runAnalysis } from "@/lib/analyst";
import type { AnalysisOutcome, AnalystContext } from "@/lib/analyst";
import { db } from "@/lib/db";
import { computeInsights } from "@/lib/insights";
import { type FactsPacket, type CallLog, providerFromEnv, writeOfferCopy } from "@/lib/llm";
import { type OfferCandidate, buildOffers, isBrandSafe } from "@/lib/offers";
import type { ParsedReport } from "@/lib/reports";

/** Most new drafts one restaurant can get per day, to keep AI costs predictable. */
export const DAILY_DRAFT_CAP = Number(process.env.DAILY_DRAFT_CAP ?? 20);
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
async function usableReports(restaurantId: string) {
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
    where: { restaurantId: restaurant.id, status: { in: ["APPROVED", "SKIPPED"] } },
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
    where: { restaurantId: restaurant.id, dataHash, status: "DONE" },
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
  const outcome = await runAnalysis(analyst, ctx, baseline, decisions.map((d) => d.title));
  const aiOffers = outcome.proposals.map((p) => proposalToOffer(p, ctx, outcome.toolLog));
  const findings = outcome.findings.map((f) => ({ title: f.title, detail: f.detail, citations: citationsFor(f.evidence, outcome) }));
  await db.analysisRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
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
  await db.llmCall.create({
    data: {
      restaurantId: restaurant.id,
      provider: analyst.provider,
      model: analyst.model,
      purpose: "analysis",
      outcome: outcome.status === "DONE" ? "ok" : "error",
      attempts: outcome.turns,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      durationMs: Date.now() - started,
      error: outcome.error ?? null,
    },
  });
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

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

async function draftsToday(restaurantId: string) {
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

  const { offers, analysisRunId, note } = await ideasFor(restaurant, rows);
  const provider = providerFromEnv();
  let created = 0;
  let reused = 0;
  let fellBack = 0;

  for (const offer of offers) {
    const packet = packetFor(restaurant, offer);
    const factsHash = hashPacket(packet, offer);
    if (await db.draft.findUnique({ where: { restaurantId_factsHash: { restaurantId, factsHash } } })) {
      reused++;
      continue;
    }
    if ((await draftsToday(restaurantId)) >= DAILY_DRAFT_CAP) {
      return `Created ${created}; stopped at the daily limit of ${DAILY_DRAFT_CAP} drafts. ${note}.`;
    }

    const copy = await writeOfferCopy(provider, packet);
    await logCall(restaurantId, copy.log);
    if (copy.fellBack) fellBack++;

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
        headline: copy.headline,
        body: copy.body,
        writtenBy: copy.writtenBy,
        factsHash,
      },
    });
    created++;
  }
  // Standard ideas the analyst dropped leave the inbox if they were still waiting.
  const keys = offers.map((o) => o.key);
  const removed = await db.draft.deleteMany({ where: { restaurantId, status: "PENDING", offerKey: { notIn: keys } } });
  return `Created ${created}, unchanged ${reused}${removed.count ? `, removed ${removed.count}` : ""}${fellBack ? `, ${fellBack} written from templates after an AI error` : ""}; ${note}.`;
}

/** Queue a rebuild for a restaurant, unless one is already waiting. */
export async function enqueueDraftJob(restaurantId: string) {
  const waiting = await db.draftJob.findFirst({ where: { restaurantId, status: "QUEUED" } });
  return waiting ?? db.draftJob.create({ data: { restaurantId } });
}

let draining = false;

/**
 * Processes queued jobs oldest first, one at a time. Safe to call often:
 * a second call while one is draining returns straight away, and each job
 * is claimed atomically so two servers can't run the same one.
 */
export async function processDraftJobs(maxJobs = 20) {
  if (draining) return;
  draining = true;
  try {
    for (let i = 0; i < maxJobs; i++) {
      const next = await db.draftJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
      if (!next) return;
      const busy = await db.draftJob.count({ where: { restaurantId: next.restaurantId, status: "RUNNING" } });
      if (busy > 0) return;
      const claimed = await db.draftJob.updateMany({
        where: { id: next.id, status: "QUEUED" },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      try {
        const message = await buildDraftsFor(next.restaurantId);
        await db.draftJob.update({ where: { id: next.id }, data: { status: "DONE", message, finishedAt: new Date() } });
      } catch (err) {
        await db.draftJob.update({
          where: { id: next.id },
          data: { status: "FAILED", message: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
        });
      }
    }
  } finally {
    draining = false;
  }
}

/** Jobs left RUNNING by a crash or restart go back in the queue after 10 minutes. */
export async function requeueStaleJobs() {
  await db.draftJob.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "QUEUED", startedAt: null },
  });
}
