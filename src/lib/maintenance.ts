import { db } from "@/lib/db";

/**
 * Keeps the database small as restaurants pile up history: expired cache
 * entries, finished jobs and old AI logs are removed. Decisions, drafts,
 * customers and reports are never touched. The worker runs this hourly.
 */
export const RETENTION_DAYS = { jobs: 30, aiLogs: 90, analysisRuns: 90 };

const daysAgo = (n: number, now: Date) => new Date(now.getTime() - n * 86_400_000);

export async function housekeeping(now = new Date()) {
  const [cache, jobs, calls, runs] = await Promise.all([
    db.cacheEntry.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.draftJob.deleteMany({ where: { status: { in: ["DONE", "FAILED"] }, createdAt: { lt: daysAgo(RETENTION_DAYS.jobs, now) } } }),
    db.llmCall.deleteMany({ where: { createdAt: { lt: daysAgo(RETENTION_DAYS.aiLogs, now) } } }),
    // Old analyses no draft points to any more (drafts keep their own copy of what they need).
    db.analysisRun.deleteMany({ where: { createdAt: { lt: daysAgo(RETENTION_DAYS.analysisRuns, now) }, drafts: { none: {} } } }),
  ]);
  return { cache: cache.count, jobs: jobs.count, aiLogs: calls.count, analysisRuns: runs.count };
}

/** For a load balancer or uptime check: is the database reachable, and is the job queue moving? */
export async function health(now = new Date()) {
  const started = Date.now();
  await db.$queryRaw`SELECT 1`;
  const oldest = await db.draftJob.findFirst({ where: { status: "QUEUED", OR: [{ runAfter: null }, { runAfter: { lte: now } }] }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const waitingSeconds = oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : 0;
  return { ok: true, dbMs: Date.now() - started, queueWaitSeconds: waitingSeconds };
}
