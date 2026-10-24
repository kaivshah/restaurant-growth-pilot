import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Two-tier cache for external lookups (Google Places, Hunter, web search,
 * event APIs):
 *
 *   1. memory: a small LRU per process, for repeat reads within seconds;
 *   2. Postgres (CacheEntry): shared by every web server and worker, so a
 *      result fetched once is reused by all restaurants in the same area.
 *
 * Concurrent requests for the same key share one in-flight call
 * ("single flight"), so ten clicks don't become ten API calls. Errors are
 * never cached. CACHE="off" turns caching off.
 */

const MEMORY_MAX = 500;
const memory = new Map<string, { value: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

export const cacheStats = { memoryHits: 0, sharedHits: 0, misses: 0 };

/** A short, stable key: "places:3f2a…" from any JSON-able parts. */
export function cacheKey(namespace: string, ...parts: unknown[]): string {
  return `${namespace}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

// Dates survive the round trip through JSON.
function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (k, x) {
      const raw = (this as Record<string, unknown>)[k];
      return raw instanceof Date ? { $date: raw.toISOString() } : x;
    }),
  );
}
function fromJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_k, x) => (x && typeof x === "object" && typeof x.$date === "string" && Object.keys(x).length === 1 ? new Date(x.$date) : x)) as T;
}

function remember(key: string, value: unknown, expiresAt: number) {
  memory.delete(key);
  memory.set(key, { value, expiresAt });
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

const enabled = () => process.env.CACHE !== "off";
// Unit tests run without a database; they use the memory tier only.
const sharedTier = () => !process.env.VITEST;

export interface CacheOptions<T> {
  /** A different lifetime for some values, e.g. shorter for empty results */
  ttlFor?: (value: T) => number;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts: CacheOptions<T> = {}): Promise<T> {
  if (!enabled()) return fn();
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expiresAt > now) {
    cacheStats.memoryHits++;
    remember(key, hit.value, hit.expiresAt);
    return fromJson<T>(hit.value);
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const work = (async () => {
    if (sharedTier()) {
      const row = await db.cacheEntry.findUnique({ where: { key } }).catch(() => null);
      if (row && row.expiresAt.getTime() > Date.now()) {
        cacheStats.sharedHits++;
        remember(key, row.value, row.expiresAt.getTime());
        return fromJson<T>(row.value);
      }
    }
    cacheStats.misses++;
    const value = await fn();
    const life = opts.ttlFor?.(value) ?? ttlMs;
    if (life > 0) {
      const stored = toJson(value);
      const expiresAt = Date.now() + life;
      remember(key, stored, expiresAt);
      if (sharedTier()) {
        await db.cacheEntry
          .upsert({ where: { key }, create: { key, value: stored as object, expiresAt: new Date(expiresAt) }, update: { value: stored as object, expiresAt: new Date(expiresAt) } })
          .catch(() => {});
        // Now and then, clear out expired rows.
        if (Math.random() < 0.02) await db.cacheEntry.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
      }
    }
    return value;
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** For tests. */
export function clearMemoryCache() {
  memory.clear();
  inflight.clear();
  Object.assign(cacheStats, { memoryHits: 0, sharedHits: 0, misses: 0 });
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
