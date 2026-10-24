import { beforeEach, describe, expect, it } from "vitest";
import { cacheKey, cacheStats, cached, clearMemoryCache } from "./index";

beforeEach(() => clearMemoryCache());

describe("cache", () => {
  it("calls the source once and serves repeats from memory", async () => {
    let calls = 0;
    const fetch = () => cached(cacheKey("t", "a"), 60_000, async () => ++calls);
    expect(await fetch()).toBe(1);
    expect(await fetch()).toBe(1);
    expect(calls).toBe(1);
    expect(cacheStats).toMatchObject({ misses: 1, memoryHits: 1 });
  });

  it("merges concurrent requests for the same key into one call", async () => {
    let calls = 0;
    const slow = () => cached(cacheKey("t", "b"), 60_000, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "ok";
    });
    expect(await Promise.all([slow(), slow(), slow()])).toEqual(["ok", "ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("keeps dates as dates", async () => {
    const when = new Date("2026-11-14T12:00:00Z");
    await cached(cacheKey("t", "c"), 60_000, async () => [{ startsAt: when }]);
    const again = await cached(cacheKey("t", "c"), 60_000, async () => [{ startsAt: new Date(0) }]);
    expect(again[0].startsAt).toBeInstanceOf(Date);
    expect(again[0].startsAt.toISOString()).toBe(when.toISOString());
  });

  it("never caches errors", async () => {
    let calls = 0;
    const flaky = () => cached(cacheKey("t", "d"), 60_000, async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return "up";
    });
    await expect(flaky()).rejects.toThrow("down");
    expect(await flaky()).toBe("up");
  });

  it("can give some values a shorter life, or none", async () => {
    let calls = 0;
    const empty = () => cached(cacheKey("t", "e"), 60_000, async () => (++calls, [] as number[]), { ttlFor: (v) => (v.length ? 60_000 : 0) });
    await empty();
    await empty();
    expect(calls).toBe(2);
  });

  it("builds stable keys from the parts", () => {
    expect(cacheKey("places", "office", ["32.959", "-117.145"], 3)).toBe(cacheKey("places", "office", ["32.959", "-117.145"], 3));
    expect(cacheKey("places", "office", 3)).not.toBe(cacheKey("places", "school", 3));
  });
});

describe("cached providers", () => {
  it("asks Google once per area and category, even for slightly different points", async () => {
    const { cachedPlaces } = await import("@/lib/places");
    let searches = 0;
    const places = cachedPlaces({
      name: "google",
      geocode: async () => ({ lat: 32.75, lng: -117.13 }),
      search: async () => (++searches, []),
    });
    await places.search("office", { lat: 32.75012, lng: -117.13004 }, 5);
    await places.search("office", { lat: 32.75014, lng: -117.13001 }, 5);
    await places.search("school", { lat: 32.75012, lng: -117.13004 }, 5);
    expect(searches).toBe(2);
  });

  it("shares Hunter results for a domain", async () => {
    const { cachedContacts } = await import("@/lib/contacts");
    let lookups = 0;
    const hunter = cachedContacts({ name: "hunter", findByDomain: async () => (++lookups, []), verify: async () => "valid" });
    await hunter.findByDomain("Acme.example");
    await hunter.findByDomain("acme.example");
    expect(lookups).toBe(1);
  });
});
