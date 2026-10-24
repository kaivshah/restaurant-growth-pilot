/**
 * Background worker: runs queued jobs (offer drafting, area scans, AI
 * suggestions, pitch writing) outside the web server.
 *
 *   npm run worker
 *
 * Run one or more of these next to the web app and set JOBS_IN_WEB="false"
 * on the web servers, so page requests only queue work and return at once.
 * Workers claim jobs with FOR UPDATE SKIP LOCKED, so any number can run side
 * by side, and they share one Gemini rate limit through Postgres.
 */
import { loadEnv } from "./env";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);

async function main() {
  loadEnv();
  const { processDraftJobs, requeueStaleJobs } = await import("@/lib/drafts");
  const { db } = await import("@/lib/db");
  let stopping = false;
  const stop = () => {
    if (!stopping) console.log("[worker] finishing the current jobs, then stopping…");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(`[worker] started; checking for jobs every ${POLL_MS / 1000}s`);
  while (!stopping) {
    try {
      await requeueStaleJobs();
      await processDraftJobs();
    } catch (err) {
      console.error("[worker] error:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await db.$disconnect();
  console.log("[worker] stopped");
}

main().then(() => process.exit(0));
