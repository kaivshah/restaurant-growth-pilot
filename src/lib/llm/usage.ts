import { db } from "@/lib/db";

/**
 * Daily request counts for metered AI APIs, by Pacific-time day (Google's
 * free quotas reset at midnight Pacific). The daily limit is learned from
 * the provider's own "quota exceeded" reply; once it's used up, no more
 * requests are sent until the reset, so jobs wait instead of burning retries.
 */

const TZ = "America/Los_Angeles";

/** "2026-10-25" for the given moment in Pacific time. */
export function pacificDay(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The next midnight in Pacific time. */
export function nextPacificMidnight(at = new Date()): Date {
  const today = pacificDay(at);
  // Step forward an hour at a time until the Pacific date changes, then back to the exact minute.
  let t = at.getTime();
  while (pacificDay(new Date(t)) === today) t += 3_600_000;
  for (let step = 30 * 60_000; step >= 60_000; step /= 2) while (pacificDay(new Date(t - step)) !== today) t -= step;
  return new Date(Math.ceil(t / 60_000) * 60_000);
}

export interface UsageToday {
  provider: string;
  day: string;
  count: number;
  /** Learned from the provider, or set with GEMINI_RPD */
  limit: number | null;
  exhaustedUntil: Date | null;
}

const memory = new Map<string, UsageToday>();
const shared = () => !process.env.VITEST;
const key = (provider: string, day: string) => `${provider}:${day}`;

function configuredLimit(provider: string) {
  const v = Number(process.env[`${provider.toUpperCase()}_RPD`] ?? 0);
  return v > 0 ? v : null;
}

export async function usageToday(provider: string, at = new Date()): Promise<UsageToday> {
  const day = pacificDay(at);
  const empty: UsageToday = { provider, day, count: 0, limit: configuredLimit(provider), exhaustedUntil: null };
  const row = shared() ? await db.apiUsage.findUnique({ where: { key: key(provider, day) } }).catch(() => null) : null;
  const base = row ? { provider, day, count: row.count, limit: row.limit, exhaustedUntil: row.exhaustedUntil } : (memory.get(key(provider, day)) ?? empty);
  return { ...base, limit: configuredLimit(provider) ?? base.limit };
}

/** Why no request should be sent right now, with how long to wait; or null. */
export async function dailyBlock(provider: string, at = new Date()): Promise<{ message: string; waitMs: number } | null> {
  const u = await usageToday(provider, at);
  const resetsIn = nextPacificMidnight(at).getTime() - at.getTime();
  if (u.exhaustedUntil && u.exhaustedUntil > at) {
    return { message: `the free daily limit${u.limit ? ` of ${u.limit} requests` : ""} is used up (${u.count} sent today); it resets at midnight Pacific`, waitMs: u.exhaustedUntil.getTime() - at.getTime() };
  }
  if (u.limit && u.count >= u.limit) return { message: `today's ${u.limit} requests are used (${provider.toUpperCase()}_RPD or Google's limit); it resets at midnight Pacific`, waitMs: resetsIn };
  return null;
}

/** Counts one request that reached the provider. */
export async function countRequest(provider: string, at = new Date()) {
  const day = pacificDay(at);
  const k = key(provider, day);
  const m = memory.get(k) ?? { provider, day, count: 0, limit: null, exhaustedUntil: null };
  memory.set(k, { ...m, count: m.count + 1 });
  if (shared()) {
    await db.apiUsage.upsert({ where: { key: k }, create: { key: k, provider, day, count: 1 }, update: { count: { increment: 1 } } }).catch(() => {});
  }
}

/** The provider said the daily quota is used up: stop until midnight Pacific and remember the limit. */
export async function markExhausted(provider: string, limit: number | null, at = new Date()) {
  const day = pacificDay(at);
  const k = key(provider, day);
  const until = nextPacificMidnight(at);
  const m = memory.get(k) ?? { provider, day, count: 0, limit: null, exhaustedUntil: null };
  memory.set(k, { ...m, limit: limit ?? m.limit, exhaustedUntil: until });
  if (shared()) {
    await db.apiUsage
      .upsert({ where: { key: k }, create: { key: k, provider, day, limit, exhaustedUntil: until }, update: { exhaustedUntil: until, ...(limit ? { limit } : {}) } })
      .catch(() => {});
  }
  console.log(`[${provider}] daily quota used up${limit ? ` (limit ${limit})` : ""}; pausing AI requests until ${until.toISOString()}`);
}

/** For tests. */
export function clearUsageMemory() {
  memory.clear();
}
