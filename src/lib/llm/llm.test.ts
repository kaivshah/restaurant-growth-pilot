import { describe, expect, it } from "vitest";
import { rewriteOfferCopy, templateProvider, validateCopy, writeOfferCopy } from "./index";
import { parseRetryAfter, withRetry } from "./retry";
import { type CopyProvider, type FactsPacket, ProviderError } from "./types";

const packet: FactsPacket = {
  restaurant: { name: "Subway #00000", brand: "Subway", kind: "FRANCHISE" },
  offer: {
    key: "afternoon-drink",
    title: "$1 fountain drink with any footlong, 3–5 pm",
    schedule: "Mon–Fri, 3–5 pm · for 4 weeks",
    audience: "Your email list",
    copyLabel: "Email subject",
  },
  facts: ["$1 fountain drink with any footlong", "Monday to Friday, 3 to 5 pm", "Valid for 4 weeks"],
  rules: { brandSafe: true, maxDiscountPct: 15, codePlaceholder: "[CODE]" },
};

const good = { headline: "Afternoon deal: $1 drink with any footlong", body: "Weekdays 3 to 5 pm, add a $1 fountain drink to any footlong. Show [CODE] at the counter." };
const noSleep = { sleep: async () => {}, random: () => 0.5, timeoutMs: 50 };

function fake(behaviour: (attempt: number) => Promise<{ headline: string; body: string }>): CopyProvider & { calls: number } {
  const p = {
    name: "fake",
    model: "test",
    calls: 0,
    async write() {
      p.calls++;
      return behaviour(p.calls);
    },
    async rewrite() {
      p.calls++;
      return behaviour(p.calls);
    },
  };
  return p;
}

describe("withRetry", () => {
  it("retries a rate limit and then succeeds, waiting at least the retry-after", async () => {
    const waits: number[] = [];
    let n = 0;
    const { value, attempts } = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new ProviderError("429", true, 5000);
        return "ok";
      },
      { ...noSleep, sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(waits).toEqual([5000, 5000]); // retry-after beats the 1s/2s backoff
  });

  it("backs off exponentially without a retry-after", async () => {
    const waits: number[] = [];
    await expect(
      withRetry(async () => { throw new ProviderError("503", true); }, { ...noSleep, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toThrow("503");
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry errors that won't fix themselves", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new ProviderError("401", false); }, noSleep)).rejects.toThrow("401");
    expect(n).toBe(1);
  });

  it("times out slow calls and retries them", async () => {
    let n = 0;
    const { attempts } = await withRetry(
      (signal) =>
        new Promise<string>((resolve, reject) => {
          n++;
          if (n > 1) return resolve("ok");
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      noSleep,
    );
    expect(attempts).toBe(2);
  });

  it("reads retry-after as seconds or a date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("validateCopy", () => {
  it("accepts copy that only uses the offer's facts", () => {
    expect(validateCopy(good, packet)).toEqual([]);
  });
  it("rejects invented prices, big percentages and a missing code", () => {
    const problems = validateCopy({ headline: "Huge deal", body: "Get 30% off, or a $5 meal." }, packet);
    expect(problems.join(" ")).toMatch(/30%/);
    expect(problems.join(" ")).toMatch(/\$5/);
    expect(problems.join(" ")).toMatch(/\[CODE\]/);
  });
});

describe("writeOfferCopy", () => {
  it("uses the AI copy when it passes the checks, after retrying a 429", async () => {
    const p = fake(async (n) => {
      if (n === 1) throw new ProviderError("429", true);
      return good;
    });
    const out = await writeOfferCopy(p, packet, noSleep);
    expect(out.writtenBy).toBe("fake:test");
    expect(out.log?.outcome).toBe("retried-ok");
    expect(out.log?.attempts).toBe(2);
  });

  it("falls back to the template when the provider keeps failing", async () => {
    const out = await writeOfferCopy(fake(async () => { throw new ProviderError("down", true); }), packet, noSleep);
    expect(out.writtenBy).toBe("template");
    expect(out.fellBack).toBe(true);
    expect(out.log?.outcome).toBe("error");
    expect(validateCopy(out, packet)).toEqual([]);
  });

  it("falls back to the template when the AI breaks a rule", async () => {
    const out = await writeOfferCopy(fake(async () => ({ headline: "50% off!", body: "Half price all day. [CODE]" })), packet, noSleep);
    expect(out.writtenBy).toBe("template");
    expect(out.log?.outcome).toBe("invalid-output");
  });

  it("writes every template offer within the rules", async () => {
    for (const key of ["welcome", "afternoon-drink", "weekend-bread"]) {
      const p = {
        ...packet,
        offer: { ...packet.offer, key, title: key === "weekend-bread" ? "Free chips with any 6-inch sub, Sat–Mon" : packet.offer.title },
        rules: { ...packet.rules, codePlaceholder: key === "welcome" ? null : ("[CODE]" as const) },
      };
      const out = await writeOfferCopy(templateProvider, p);
      expect(validateCopy(out, p)).toEqual([]);
    }
  });
});

describe("rewriteOfferCopy", () => {
  it("explains that templates can't rewrite", async () => {
    const out = await rewriteOfferCopy(templateProvider, packet, good, "Shorter");
    expect(out.ok).toBe(false);
  });
  it("keeps the owner's draft when the rewrite breaks a rule", async () => {
    const out = await rewriteOfferCopy(fake(async () => ({ headline: "x", body: "$9 deal" })), packet, good, "Shorter", noSleep);
    expect(out.ok).toBe(false);
  });
});
