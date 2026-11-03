import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { claudeClient, claudeError, cachedSystem, fallbackParams, inputTokensOf, CLAUDE_DEFAULT_MODEL } from "./claude";
import { SYSTEM_PROMPT, batchPitchRequest, followUpRequest, pitchItemsRequest, pitchRules, rewriteRequest, writeRequest } from "./prompt";
import { parseRetryAfter } from "./retry";
import { AiConfigError, type CopyProvider, ProviderError, type WriteResult } from "./types";
import { LATEST_FLASH, geminiGenerate, replyText, resolvedModel, usage } from "./gemini";
import { LIMITS } from "./validate";

const CopySchema = z.object({
  headline: z.string(),
  body: z.string(),
});

const BatchSchema = z.object({ items: z.array(z.object({ id: z.string(), headline: z.string(), body: z.string() })) });

const batchJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, headline: { type: "string", maxLength: LIMITS.headline }, body: { type: "string", maxLength: LIMITS.pitchBody } },
        required: ["id", "headline", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const FollowUpSchema = z.object({ items: z.array(z.object({ id: z.string(), followup1: z.string(), followup2: z.string() })) });

const followUpJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, followup1: { type: "string", maxLength: 600 }, followup2: { type: "string", maxLength: 400 } },
        required: ["id", "followup1", "followup2"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const copyJsonSchema = {
  type: "object",
  properties: {
    headline: { type: "string", maxLength: LIMITS.headline },
    body: { type: "string", maxLength: LIMITS.pitchBody },
  },
  required: ["headline", "body"],
  additionalProperties: false,
} as const;

// ---------- Gemini (Google AI Studio; has a free tier) ----------

export function geminiProvider(apiKey: string, model: string): CopyProvider {
  async function call(user: string, signal: AbortSignal): Promise<WriteResult> {
    const res = await geminiGenerate(
      apiKey,
      model,
      {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: copyJsonSchema, temperature: 0.7 },
      },
      signal,
    );
    const finish = res.candidates?.[0]?.finishReason;
    if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw new ProviderError("Gemini declined to write this", false);
    const parsed = CopySchema.safeParse(safeJson(replyText(res)));
    if (!parsed.success) throw new ProviderError("Gemini returned copy we couldn't read", true);
    return { ...parsed.data, ...usage(res) };
  }
  return {
    name: "gemini",
    get model() {
      return resolvedModel(model);
    },
    write: (packet, signal) => call(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => call(rewriteRequest(packet, current, instruction), signal),
    async writeMany(items, signal) {
      const res = await geminiGenerate(
        apiKey,
        model,
        {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: batchPitchRequest(items) }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: batchJsonSchema, temperature: 0.7 },
        },
        signal,
      );
      const parsed = BatchSchema.safeParse(safeJson(replyText(res)));
      if (!parsed.success) throw new ProviderError("Gemini returned pitches we couldn't read", true);
      return { items: parsed.data.items, ...usage(res) };
    },
    async writeFollowUps(items, signal) {
      const res = await geminiGenerate(
        apiKey,
        model,
        {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: followUpRequest(items) }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: followUpJsonSchema, temperature: 0.7 },
        },
        signal,
      );
      const parsed = FollowUpSchema.safeParse(safeJson(replyText(res)));
      if (!parsed.success) throw new ProviderError("Gemini returned follow-ups we couldn't read", true);
      return { items: parsed.data.items, ...usage(res) };
    },
  };
}

// ---------- Claude (Anthropic) ----------

/**
 * The copywriter on Claude. The instructions (and, for pitches, the
 * restaurant's rules) go in a cached system block; only each request's facts
 * change. Low effort: short emails don't need deep thinking.
 */
export function anthropicProvider(apiKey: string, model: string): CopyProvider {
  const client = claudeClient(apiKey);

  async function parse<T>(system: string[], user: string, format: ReturnType<typeof betaZodOutputFormat<z.ZodType<T>>>, maxTokens: number, signal: AbortSignal, what: string) {
    try {
      const response = await client.beta.messages.parse(
        {
          model,
          max_tokens: maxTokens,
          system: cachedSystem(...system),
          messages: [{ role: "user", content: user }],
          output_config: { format, effort: "low" },
          ...fallbackParams(model),
        },
        { signal },
      );
      if (response.stop_reason === "refusal") throw new ProviderError(`Claude declined to write ${what}`, false);
      // Cut off or unreadable: a second try usually works.
      if (!response.parsed_output) throw new ProviderError(`Claude returned ${what} we couldn't read`, true);
      return { value: response.parsed_output as T, inputTokens: inputTokensOf(response.usage), outputTokens: response.usage.output_tokens };
    } catch (err) {
      throw claudeError(err);
    }
  }

  const single = async (user: string, signal: AbortSignal): Promise<WriteResult> => {
    const r = await parse(SYSTEM_PROMPT_PARTS, user, betaZodOutputFormat(CopySchema), 4000, signal, "this copy");
    return { ...r.value, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  };

  return {
    name: "anthropic",
    model,
    write: (packet, signal) => single(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => single(rewriteRequest(packet, current, instruction), signal),
    async writeMany(items, signal) {
      // The restaurant's pitch rules are the same for every batch it sends, so they're cached with the instructions.
      const r = await parse([...SYSTEM_PROMPT_PARTS, pitchRules(items[0].packet)], pitchItemsRequest(items), betaZodOutputFormat(BatchSchema), 4000 + items.length * 800, signal, "these pitches");
      return { items: r.value.items, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    },
    async writeFollowUps(items, signal) {
      const r = await parse(SYSTEM_PROMPT_PARTS, followUpRequest(items), betaZodOutputFormat(FollowUpSchema), 3000 + items.length * 600, signal, "these follow-ups");
      return { items: r.value.items, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    },
  };
}

const SYSTEM_PROMPT_PARTS = [SYSTEM_PROMPT];

// ---------- Ollama (free, runs open models such as Qwen or Llama locally) ----------

/**
 * Ollama reads only the first 4,096 tokens of a request by default and drops
 * the rest without saying so; a batch of pitches or the lead list needs more.
 */
export const ollamaOptions = (temperature: number, env: NodeJS.ProcessEnv = process.env) => ({ temperature, num_ctx: Number(env.OLLAMA_NUM_CTX ?? 16384) });

export function ollamaProvider(baseUrl: string, model: string): CopyProvider {
  async function chat(user: string, format: unknown, signal: AbortSignal): Promise<{ json: unknown; inputTokens?: number; outputTokens?: number }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          format,
          // Keep the model loaded between requests so each one doesn't wait for it to load again.
          keep_alive: "30m",
          options: ollamaOptions(0.6),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderError(`Can't reach Ollama at ${baseUrl}. Is it running?`, true);
    }
    if (res.status === 404) throw new AiConfigError(`Ollama doesn't have the model "${model}". Run: ollama pull ${model}`);
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError(`Ollama returned ${res.status}`, true, parseRetryAfter(res.headers.get("retry-after")));
    }
    if (!res.ok) throw new ProviderError(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`, false);
    const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return { json: safeJson(data.message?.content), inputTokens: data.prompt_eval_count, outputTokens: data.eval_count };
  }

  async function call(user: string, signal: AbortSignal): Promise<WriteResult> {
    const { json, ...tokens } = await chat(user, copyJsonSchema, signal);
    const parsed = CopySchema.safeParse(json);
    // Small models sometimes return broken JSON; a second try usually works.
    if (!parsed.success) throw new ProviderError("The local model returned copy we couldn't read", true);
    return { ...parsed.data, ...tokens };
  }

  return {
    name: "ollama",
    model,
    // A laptop writes about 20 words a second, so smaller batches finish within the time limit.
    batchSize: 3,
    write: (packet, signal) => call(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => call(rewriteRequest(packet, current, instruction), signal),
    async writeMany(items, signal) {
      const { json, ...tokens } = await chat(batchPitchRequest(items), batchJsonSchema, signal);
      const parsed = BatchSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError("The local model returned pitches we couldn't read", false);
      return { items: parsed.data.items, ...tokens };
    },
    async writeFollowUps(items, signal) {
      const { json, ...tokens } = await chat(followUpRequest(items), followUpJsonSchema, signal);
      const parsed = FollowUpSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError("The local model returned follow-ups we couldn't read", false);
      return { items: parsed.data.items, ...tokens };
    },
  };
}

function safeJson(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---------- Choosing a provider from the environment ----------

/**
 * The copywriter chosen by LLM_PROVIDER (Claude by default), or null when its
 * key is missing. Without a provider no drafts are written.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): CopyProvider | null {
  const choice = (env.LLM_PROVIDER || "anthropic").toLowerCase();
  if (choice === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return null;
    return anthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL);
  }
  if (choice === "ollama") {
    return ollamaProvider(env.OLLAMA_URL || "http://localhost:11434", env.OLLAMA_MODEL || "qwen2.5:7b-instruct");
  }
  if (choice === "gemini") {
    if (!env.GEMINI_API_KEY) return null;
    return geminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL || LATEST_FLASH);
  }
  return null;
}

/** Why there's no copywriter, for the setup notice. */
export function missingAiReason(env: NodeJS.ProcessEnv = process.env): string {
  const choice = (env.LLM_PROVIDER || "anthropic").toLowerCase();
  if (choice === "anthropic") return "Add your Claude API key as ANTHROPIC_API_KEY in .env (from platform.claude.com), then restart the app.";
  if (choice === "gemini") return "Add a free Gemini key as GEMINI_API_KEY in .env (from aistudio.google.com), then restart the app.";
  return `LLM_PROVIDER="${choice}" isn't supported. Use gemini, anthropic or ollama.`;
}
