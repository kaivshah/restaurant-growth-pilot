import { AiConfigError, ProviderError } from "./types";

/**
 * Minimal client for the Gemini API (generateContent). Free keys come from
 * Google AI Studio. Shared by the copywriter and the AI analyst.
 */

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiResponse = {
  candidates?: { content?: GeminiContent; finishReason?: string; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

/** GEMINI_BASE_URL can point at a proxy or a local mock for testing. */
const base = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");

/** Turns a Gemini error reply into a ProviderError the retry loop understands. */
export function geminiError(status: number, body: unknown): ProviderError | AiConfigError {
  const err = (body as { error?: { message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] } })?.error;
  const message = err?.message?.slice(0, 300) ?? `HTTP ${status}`;
  if (status === 429 || status >= 500) {
    const delay = err?.details?.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay;
    const seconds = delay ? parseFloat(delay) : NaN;
    const busy = status === 429 ? "Gemini free limit reached" : `Gemini unavailable (${status})`;
    return new ProviderError(`${busy}: ${message}`, true, Number.isFinite(seconds) ? seconds * 1000 : undefined);
  }
  if (status === 401 || status === 403 || /API key/i.test(message)) return new AiConfigError("Gemini API key is missing or invalid. Check GEMINI_API_KEY in .env.");
  if (status === 404 || err?.status === "NOT_FOUND") return new AiConfigError(`Gemini model not available: ${message.slice(0, 160)}`);
  return new ProviderError(`Gemini error ${status}: ${message}`, false);
}

/** Google's alias for its current Flash model. */
export const LATEST_FLASH = "gemini-flash-latest";

/** Models that turned out to be retired, mapped to the one that worked instead. */
const replaced = new Map<string, string>();

/** The model actually in use for a configured name (after any automatic replacement). */
export function resolvedModel(model: string): string {
  return replaced.get(model) ?? model;
}

/** The model a "no longer available" error suggests, else the latest Flash. */
export function replacementFor(model: string, message: string): string | null {
  // "…use models/gemini-3.8-flash for…": take the name, minus any sentence punctuation after it.
  const suggested = message.match(/use models\/(gemini-[\w.-]+)/)?.[1]?.replace(/[.-]+$/, "");
  const next = suggested ?? LATEST_FLASH;
  return next === model ? null : next;
}

/** JSON Schema keywords some Gemini models reject; dropped on a retry if the schema is refused. */
const UNSUPPORTED = new Set(["additionalProperties", "$schema", "default"]);

export function simplifySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(simplifySchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, simplifySchema(pv)])) : simplifySchema(v)]));
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: ({ functionDeclarations: { name: string; description: string; parametersJsonSchema: unknown }[] } | { google_search: Record<string, never> })[];
  generationConfig?: Record<string, unknown>;
}

/**
 * One generateContent call. Retries are the caller's job (withRetry). If the
 * configured model has been retired, switches once to the suggested model
 * (or the latest Flash) and keeps using it.
 */
export async function geminiGenerate(apiKey: string, model: string, req: GeminiRequest, signal: AbortSignal): Promise<GeminiResponse> {
  try {
    return await generateWith(apiKey, resolvedModel(model), req, signal);
  } catch (err) {
    if (!(err instanceof AiConfigError) || !err.message.startsWith("Gemini model not available")) throw err;
    const next = replacementFor(resolvedModel(model), err.message);
    if (!next) throw err;
    const out = await generateWith(apiKey, next, req, signal);
    replaced.set(model, next);
    console.warn(`GEMINI_MODEL ${model} isn't available; using ${next}. Update GEMINI_MODEL in .env.`);
    return out;
  }
}

/**
 * Requests are spaced to stay under the free tier's per-minute limit
 * (GEMINI_RPM, default 10), shared by every job in this server. After a 429
 * the next request waits for the delay Google asked for.
 */
let nextSlot = 0;

export function geminiInterval(env: NodeJS.ProcessEnv = process.env) {
  const rpm = Number(env.GEMINI_RPM ?? 10);
  return rpm > 0 ? 60_000 / rpm : 0;
}

async function waitForSlot(signal: AbortSignal) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  const interval = geminiInterval();
  nextSlot = at + interval;
  if (at <= now) return;
  const waitMs = at - now;
  if (waitMs > 1500) console.log(`[gemini] waiting ${Math.round(waitMs / 1000)}s for the free per-minute limit (GEMINI_RPM=${Math.round(60_000 / interval)})`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        // Give the unused turn back, so waits don't pile up after timeouts.
        nextSlot = Math.max(Date.now(), nextSlot - interval);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function generateWith(apiKey: string, model: string, req: GeminiRequest, signal: AbortSignal): Promise<GeminiResponse> {
  await waitForSlot(signal);
  const started = Date.now();
  // Thinking models can take a while; say so in the terminal instead of going quiet.
  const slow = setInterval(() => console.log(`[gemini] ${model} still answering after ${Math.round((Date.now() - started) / 1000)}s…`), 20_000);
  signal.addEventListener("abort", () => clearInterval(slow), { once: true });
  try {
    const out = await requestOnce(apiKey, model, req, signal);
    console.log(`[gemini] ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return out;
  } catch (err) {
    console.log(`[gemini] ${model} ${signal.aborted ? `gave no answer within the time limit (${Math.round((Date.now() - started) / 1000)}s)` : `failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`}`);
    throw err;
  } finally {
    clearInterval(slow);
  }
}

async function requestOnce(apiKey: string, model: string, req: GeminiRequest, signal: AbortSignal): Promise<GeminiResponse> {
  const send = (body: GeminiRequest) =>
    fetch(`${base()}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
  let res: Response;
  try {
    res = await send(req);
    // Some models refuse parts of standard JSON Schema; try once with a simpler schema.
    if (res.status === 400) {
      const text = await res.text();
      if (!/schema|parameters|Invalid JSON payload/i.test(text)) throw geminiError(400, safeJson(text));
      res = await send(simplifyRequest(req));
    }
  } catch (err) {
    if (err instanceof ProviderError || err instanceof AiConfigError || signal.aborted) throw err;
    throw new ProviderError("Can't reach the Gemini API. Check your internet connection.", true);
  }
  const body = safeJson(await res.text());
  if (!res.ok) {
    const err = geminiError(res.status, body);
    // Honour Google's "retry in Ns" for the next request, up to a minute; longer waits make the job retry later.
    if (err instanceof ProviderError && err.retryAfterMs) nextSlot = Math.max(nextSlot, Date.now() + Math.min(err.retryAfterMs, 60_000));
    throw err;
  }
  const out = body as GeminiResponse;
  if (out.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the request (${out.promptFeedback.blockReason})`, false);
  return out;
}

function simplifyRequest(req: GeminiRequest): GeminiRequest {
  return {
    ...req,
    tools: req.tools?.map((t) => ("functionDeclarations" in t ? { functionDeclarations: t.functionDeclarations.map((f) => ({ ...f, parametersJsonSchema: simplifySchema(f.parametersJsonSchema) })) } : t)),
    generationConfig: req.generationConfig?.responseJsonSchema
      ? { ...req.generationConfig, responseJsonSchema: simplifySchema(req.generationConfig.responseJsonSchema) }
      : req.generationConfig,
  };
}

/** The visible text of a reply (thought summaries left out). */
export function replyText(r: GeminiResponse): string {
  return (r.candidates?.[0]?.content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
}

export function usage(r: GeminiResponse) {
  const u = r.usageMetadata ?? {};
  return { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}
