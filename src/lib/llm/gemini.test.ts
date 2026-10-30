import { afterEach, describe, expect, it, vi } from "vitest";

// Pacing is tested on its own; the other tests send requests back to back.
process.env.GEMINI_RPM = "0";
import { geminiAnalyst } from "@/lib/analyst/models";
import { AiBusyError, AiConfigError, writeOfferCopy } from "@/lib/llm";
import { jobState, retryLater } from "@/lib/drafts";
import { geminiError, geminiInterval, replacementFor, resetOverload, simplifySchema } from "./gemini";
import { geminiProvider } from "./providers";
import { ProviderError } from "./types";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  resetOverload();
  delete process.env.GEMINI_FALLBACK_MODEL;
});

describe("Gemini errors", () => {
  it("reads the retry delay from a 429", () => {
    const err = geminiError(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] },
    });
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).retryAfterMs).toBe(37_000);
    expect(err.message).toMatch(/free limit/);
  });

  it("treats a bad key as permanent", () => {
    const err = geminiError(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key." } });
    expect(err).toBeInstanceOf(AiConfigError);
    expect(err.message).toMatch(/Gemini API key is missing or invalid/);
  });

  it("can drop schema keywords a model refuses", () => {
    expect(simplifySchema({ type: "object", additionalProperties: false, properties: { a: { type: "string", default: "x" } } })).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });
});

describe("Gemini copywriter", () => {
  it("sends the prompt with a JSON schema and reads the copy and token counts", async () => {
    const fetchMock = vi.fn(async () =>
      reply({
        candidates: [{ content: { role: "model", parts: [{ text: '{"headline":"Hi","body":"Hello there."}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = geminiProvider("key", "gemini-2.5-flash");
    const out = await p.write(
      { restaurant: { name: "S", brand: null, kind: "INDEPENDENT" }, offer: { key: "k", title: "T", schedule: "S", audience: "A", copyLabel: "Subject" }, facts: [], rules: { brandSafe: false, maxDiscountPct: 10, codePlaceholder: null } },
      new AbortController().signal,
    );
    expect(out).toEqual({ headline: "Hi", body: "Hello there.", inputTokens: 120, outputTokens: 40 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/models/gemini-2.5-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toMatch(/marketing copy/);
  });
});

describe("Gemini analyst", () => {
  it("runs tool calls, keeps thought signatures, and sends results back", async () => {
    const turns = [
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "list_leads", args: { top: 5 } }, thoughtSignature: "sig1" }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20 } },
      { candidates: [{ content: { role: "model", parts: [{ text: "Done." }] } }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 5 } },
    ];
    const bodies: { contents: { role: string; parts: Record<string, unknown>[] }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return reply(turns[bodies.length - 1]);
      }),
    );
    const session = geminiAnalyst("key", "gemini-2.5-flash").start({ system: "sys", user: "hello", tools: [{ name: "list_leads", description: "d", inputSchema: { type: "object" } }] });
    const t1 = await session.send(null, new AbortController().signal);
    expect(t1.toolCalls).toEqual([{ id: "gem_1", name: "list_leads", input: { top: 5 } }]);
    expect(t1.inputTokens).toBe(500);
    await session.send([{ id: "gem_1", name: "list_leads", content: JSON.stringify({ leads: [] }) }], new AbortController().signal);
    const second = bodies[1].contents;
    expect(second[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "list_leads", args: { top: 5 } }, thoughtSignature: "sig1" }] });
    expect(second[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "list_leads", response: { leads: [] } } }] });
  });

  it("forgets a turn that failed, so the retry resends it once", async () => {
    process.env.GEMINI_FALLBACK_MODEL = "off";
    let n = 0;
    const bodies: { contents: unknown[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return ++n === 1 ? reply({ error: { code: 503, message: "overloaded" } }, 503) : reply({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] });
      }),
    );
    const session = geminiAnalyst("key", "m").start({ system: "s", user: "u", tools: [] });
    await expect(session.send(null, new AbortController().signal)).rejects.toMatchObject({ retryable: true });
    await session.send(null, new AbortController().signal);
    expect(bodies[1].contents).toHaveLength(1);
  });
});

describe("waiting for a busy AI", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  it("puts the job back with a growing wait, honouring the provider's delay", () => {
    expect(retryLater(1, new AiBusyError("busy"), now)).toMatchObject({ status: "QUEUED", runAfter: new Date(now.getTime() + 2 * 60_000) });
    expect(retryLater(3, new AiBusyError("busy"), now).runAfter).toEqual(new Date(now.getTime() + 10 * 60_000));
    expect(retryLater(1, new AiBusyError("daily limit", 3 * 3_600_000), now).runAfter).toEqual(new Date(now.getTime() + 3 * 3_600_000));
  });
  it("gives up after the last try", () => {
    expect(retryLater(7, new AiBusyError("busy"), now)).toMatchObject({ status: "FAILED" });
  });
  it("tells pages whether a job is running or waiting", () => {
    expect(jobState({ status: "QUEUED", runAfter: new Date(now.getTime() + 60_000) }, now)).toBe("waiting");
    expect(jobState({ status: "QUEUED", runAfter: null }, now)).toBe("working");
    expect(jobState({ status: "DONE", runAfter: null }, now)).toBe("idle");
  });
});

const RETIRED =
  "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements. We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started).";
const packet = { restaurant: { name: "S", brand: null, kind: "INDEPENDENT" as const }, offer: { key: "k", title: "T", schedule: "S", audience: "A", copyLabel: "Subject" }, facts: [], rules: { brandSafe: false, maxDiscountPct: 10, codePlaceholder: null } };
const okCopy = { candidates: [{ content: { role: "model", parts: [{ text: '{"headline":"Hi","body":"Hello there."}' }] } }] };

describe("retired Gemini models", () => {
  it("reads the suggested replacement, else uses the latest Flash", () => {
    expect(replacementFor("gemini-2.5-flash", RETIRED)).toBe("gemini-3.8-flash");
    expect(replacementFor("gemini-9-flash", "models/gemini-9-flash is not found for API version v1beta")).toBe("gemini-flash-latest");
    expect(replacementFor("gemini-flash-latest", "not found")).toBeNull();
  });

  it("switches to the replacement and keeps using it", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes("gemini-2.5-flash") ? reply({ error: { code: 404, status: "NOT_FOUND", message: RETIRED } }, 404) : reply(okCopy);
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = geminiProvider("key", "gemini-2.5-flash");
    await p.write(packet, new AbortController().signal);
    expect(p.model).toBe("gemini-3.8-flash");
    await p.write(packet, new AbortController().signal);
    expect(urls.map((u) => u.match(/models\/([^:]+)/)?.[1])).toEqual(["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-flash"]);
  });

  it("stops at once when the key is bad, instead of trying every draft", async () => {
    const fetchMock = vi.fn(async () => reply({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const out = await writeOfferCopy(geminiProvider("bad", "gemini-3.8-flash"), packet, { sleep: async () => {}, timeoutMs: 1000 });
    expect(out).toMatchObject({ ok: false, fatal: true, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("an overloaded model", () => {
  it("answers from Flash-Lite when Flash says high demand, and keeps using it for a while", async () => {
    resetOverload();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes("/gemini-flash-latest:")
          ? reply({ error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } }, 503)
          : reply(okCopy);
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const p = geminiProvider("key", "gemini-flash-latest");
    await p.write(packet, new AbortController().signal);
    await p.write(packet, new AbortController().signal);
    expect(urls.map((u) => u.match(/models\/([^:]+)/)?.[1])).toEqual(["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-flash-lite-latest"]);
    resetOverload();
  });
});

describe("pacing for the free tier", () => {
  it("spaces requests to stay under the per-minute limit", () => {
    expect(geminiInterval({ GEMINI_RPM: "10" } as unknown as NodeJS.ProcessEnv)).toBe(6000);
    expect(geminiInterval({} as unknown as NodeJS.ProcessEnv)).toBe(6000);
    expect(geminiInterval({ GEMINI_RPM: "0" } as unknown as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("Gemini daily quota", () => {
  const dailyBody = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota.",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "43s" },
      ],
    },
  };

  it("reads the daily limit Google reports", async () => {
    const { GeminiQuotaError } = await import("./gemini");
    const err = geminiError(429, dailyBody);
    expect(err).toBeInstanceOf(GeminiQuotaError);
    expect(err).toMatchObject({ perDay: true, limit: 20, retryable: true });
    const minute = geminiError(429, { error: { code: 429, message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "10" }] }] } });
    expect(minute).toMatchObject({ perDay: false, limit: 10 });
  });

  it("stops sending once the day is used up, without calling Google again", async () => {
    const { clearUsageMemory } = await import("./usage");
    clearUsageMemory();
    const fetchMock = vi.fn(async () => reply(dailyBody, 429));
    vi.stubGlobal("fetch", fetchMock);
    const p = geminiProvider("key", "gemini-3.8-flash");
    await expect(p.write(packet, new AbortController().signal)).rejects.toMatchObject({ perDay: true });
    await expect(p.write(packet, new AbortController().signal)).rejects.toThrow(/paused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearUsageMemory();
  });

  it("knows the Pacific day and the next reset", async () => {
    const { pacificDay, nextPacificMidnight } = await import("./usage");
    const at = new Date("2026-10-25T06:30:00Z"); // 11:30 pm on Oct 24 in San Diego (PDT)
    expect(pacificDay(at)).toBe("2026-10-24");
    expect(nextPacificMidnight(at).toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });
});
