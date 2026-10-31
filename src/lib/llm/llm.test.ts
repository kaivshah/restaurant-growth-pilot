import { describe, expect, it } from "vitest";
import { providerFromEnv, rewriteOfferCopy, validateCopy, writeManyCopy, writeOfferCopy } from "./index";
import { batchPitchRequest } from "./prompt";
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
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.writtenBy).toBe("fake:test");
    expect(out.log?.outcome).toBe("retried-ok");
    expect(out.log?.attempts).toBe(2);
  });

  it("reports a busy provider as retryable instead of writing anything", async () => {
    const out = await writeOfferCopy(fake(async () => { throw new ProviderError("down", true, 1000); }), packet, noSleep);
    expect(out).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1000 });
    expect(out.log?.outcome).toBe("error");
  });

  it("doesn't retry a bad key later", async () => {
    const out = await writeOfferCopy(fake(async () => { throw new ProviderError("bad key", false); }), packet, noSleep);
    expect(out).toMatchObject({ ok: false, retryable: false });
  });

  it("asks the AI to fix copy that breaks a rule, once", async () => {
    const fixed = fake(async (n) => (n === 1 ? { headline: "50% off!", body: "Half price all day. [CODE]" } : good));
    const out = await writeOfferCopy(fixed, packet, noSleep);
    expect(out.ok).toBe(true);
    expect(fixed.calls).toBe(2);

    const stubborn = fake(async () => ({ headline: "50% off!", body: "Half price all day. [CODE]" }));
    const bad = await writeOfferCopy(stubborn, packet, noSleep);
    expect(bad).toMatchObject({ ok: false, retryable: false });
    expect(bad.log?.outcome).toBe("invalid-output");
  });
});

describe("rewriteOfferCopy", () => {
  it("keeps the owner's draft when the rewrite breaks a rule", async () => {
    const out = await rewriteOfferCopy(fake(async () => ({ headline: "x", body: "$9 deal" })), packet, good, "Shorter", noSleep);
    expect(out.ok).toBe(false);
  });
  it("returns the rewritten copy", async () => {
    const out = await rewriteOfferCopy(fake(async () => good), packet, { headline: "Old", body: "Old [CODE]" }, "Shorter", noSleep);
    expect(out.ok && out.copy).toEqual(good);
  });
  it("gives a rule-breaking rewrite one chance to be fixed", async () => {
    const p = fake(async (n) => (n === 1 ? { headline: "x", body: "$9 deal [CODE]" } : good));
    const out = await rewriteOfferCopy(p, packet, good, "Shorter", noSleep);
    expect(out.ok).toBe(true);
    expect(p.calls).toBe(2);
  });
  it("adds the franchise line to a pitch instead of throwing the rewrite away", async () => {
    const pitch: FactsPacket = {
      ...packet,
      rules: { ...packet.rules, codePlaceholder: null },
      pitch: { company: "Acme", contactFirstName: null, category: "office", distanceMiles: 1, offer: "free delivery", minOrder: 10, occasion: "Team lunches", event: null },
    };
    const p = fake(async () => ({ headline: "Subject: Lunch for Acme?", body: "Hi there, we'd love to cater your next team lunch." }));
    const out = await rewriteOfferCopy(p, pitch, good, "Shorter", noSleep);
    expect(out.ok && out.copy.headline).toBe("Lunch for Acme?");
    expect(out.ok && out.copy.body).toMatch(/Subway #00000 is independently owned and operated\.$/);
    expect(p.calls).toBe(1);
  });
});

describe("choosing a provider", () => {
  it("defaults to Gemini and needs its key", () => {
    expect(providerFromEnv({ GEMINI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)?.name).toBe("gemini");
    expect(providerFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(providerFromEnv({ LLM_PROVIDER: "template" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(providerFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)?.name).toBe("anthropic");
  });
});

describe("writing many pitches at once", () => {
  const pitch = (company: string): FactsPacket => ({
    restaurant: { name: "Subway #00000", brand: "Subway", kind: "FRANCHISE" },
    offer: { key: "pitch:free_delivery", title: "free delivery with a first catering order", schedule: "Send this week", audience: company, copyLabel: "Email subject" },
    facts: ["Free delivery with a first catering order of 10 or more people", `1 mi from ${company}`],
    rules: { brandSafe: true, maxDiscountPct: 15, codePlaceholder: null },
    pitch: { company, contactFirstName: null, category: "office", distanceMiles: 1, offer: "free delivery", minOrder: 10, occasion: "Team lunches", event: null },
  });
  const ok = (company: string) => ({ headline: `Lunch for ${company}?`, body: `Hi there, we'd love to cater for ${company}. Subway #00000 is independently owned and operated.` });
  const items = ["Acme", "Globex", "Initech"].map((c, i) => ({ id: `p${i + 1}`, packet: pitch(c) }));

  it("sends the shared rules once and every pitch's facts", () => {
    const text = batchPitchRequest(items);
    expect(text.match(/independently owned and operated/g)).toHaveLength(1);
    expect(text).toContain("### p3");
    expect(text).toContain("at Initech");
  });

  it("writes them in one request, and redoes only the ones that break a rule", async () => {
    let batches = 0;
    let singles = 0;
    const provider: CopyProvider = {
      name: "fake",
      model: "test",
      async write(p) {
        singles++;
        return ok(p.pitch!.company);
      },
      async writeMany(list) {
        batches++;
        return { items: list.map(({ id, packet }) => ({ id, ...(packet.pitch!.company === "Globex" ? { headline: "x", body: "Save 50% today" } : ok(packet.pitch!.company)) })) };
      },
    };
    const out = await writeManyCopy(provider, items, noSleep);
    expect(batches).toBe(1);
    expect(singles).toBe(1);
    expect([...out.values()].every((r) => r.ok)).toBe(true);
  });

  it("marks the whole batch for a retry when the AI is busy", async () => {
    const provider: CopyProvider = {
      name: "fake",
      model: "test",
      write: async () => ok("x"),
      writeMany: async () => {
        throw new ProviderError("429", true, 30_000);
      },
    };
    const out = await writeManyCopy(provider, items, { ...noSleep, retries: 0 });
    expect([...out.values()].every((r) => !r.ok && r.retryable)).toBe(true);
  });
});

describe("Ollama", () => {
  it("sends a large enough context, keeps the model loaded, and writes pitches in small batches", async () => {
    const { ollamaProvider } = await import("./providers");
    const bodies: { options: { num_ctx: number }; keep_alive: string; messages: { content: string }[] }[] = [];
    const fetchMock = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      const items = [{ id: "a", headline: "Lunch for your team", body: "Hi, we cater team lunches nearby." }];
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ items }) }, prompt_eval_count: 900, eval_count: 300 }), { status: 200 });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const p = ollamaProvider("http://localhost:11434", "qwen2.5:7b-instruct");
      expect(p.batchSize).toBe(3);
      const packet: FactsPacket = {
        restaurant: { name: "Subway #00000", brand: "Subway", kind: "FRANCHISE" },
        offer: { key: "pitch:free_delivery", title: "free delivery", schedule: "Send this week", audience: "Acme", copyLabel: "Email subject" },
        facts: ["Free delivery with a first catering order"],
        rules: { brandSafe: true, maxDiscountPct: 15, codePlaceholder: null },
        pitch: { company: "Acme", contactFirstName: null, category: "office", distanceMiles: 1, offer: "free delivery", minOrder: 10, occasion: "Team lunches", event: null },
      };
      const res = await p.writeMany!([{ id: "a", packet }], new AbortController().signal);
      expect(res.items[0].id).toBe("a");
      expect(bodies[0].options.num_ctx).toBe(16384);
      expect(bodies[0].keep_alive).toBe("30m");
      expect(res.inputTokens).toBe(900);
    } finally {
      globalThis.fetch = original;
    }
  });
});
