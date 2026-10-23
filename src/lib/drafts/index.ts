import { createHash } from "node:crypto";
import type { Prisma, Restaurant } from "@prisma/client";
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
  return { reports: rows.map((r) => r.data as unknown as ParsedReport), anyConfirmed: rows.some((r) => r.status === "CONFIRMED") };
}

async function draftsToday(restaurantId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.draft.count({ where: { restaurantId, createdAt: { gte: start } } });
}

/** Builds offer drafts for one restaurant. Returns a short summary for the job record. */
export async function buildDraftsFor(restaurantId: string): Promise<string> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return "Restaurant not found.";
  const { reports, anyConfirmed } = await usableReports(restaurantId);
  if (!anyConfirmed) return "Waiting for confirmed reports.";

  const offers = buildOffers(computeInsights(reports), restaurant);
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
      return `Created ${created}; stopped at the daily limit of ${DAILY_DRAFT_CAP} drafts.`;
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
  return `Created ${created}, unchanged ${reused}${fellBack ? `, ${fellBack} written from templates after an AI error` : ""}.`;
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
