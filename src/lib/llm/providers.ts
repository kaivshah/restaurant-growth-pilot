import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { SYSTEM_PROMPT, batchPitchRequest, followUpRequest, rewriteRequest, writeRequest } from "./prompt";
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

function anthropicError(err: unknown): ProviderError | AiConfigError {
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Claude rate limit reached", true, parseRetryAfter(err.headers?.get("retry-after")));
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Claude unavailable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.AuthenticationError) return new AiConfigError("Claude API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.");
  if (err instanceof Anthropic.NotFoundError) return new AiConfigError(`Claude model not found: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude error ${err.status}: ${err.message}`, false);
  if (err instanceof ProviderError || err instanceof AiConfigError) return err;
  return new ProviderError(err instanceof Error ? err.message : String(err), false);
}

export function anthropicProvider(apiKey: string, model: string): CopyProvider {
  // Retries are handled by withRetry so every provider behaves the same.
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  async function call(user: string, signal: AbortSignal): Promise<WriteResult> {
    try {
      const response = await client.messages.parse(
        {
          model,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: user }],
          output_config: { format: zodOutputFormat(CopySchema), effort: "low" },
        },
        { signal },
      );
      if (response.stop_reason === "refusal") throw new ProviderError("Claude declined to write this offer", false);
      if (!response.parsed_output) throw new ProviderError("Claude returned copy we couldn't read", false);
      return {
        ...response.parsed_output,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      throw anthropicError(err);
    }
  }

  return {
    name: "anthropic",
    model,
    write: (packet, signal) => call(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => call(rewriteRequest(packet, current, instruction), signal),
    async writeMany(items, signal) {
      try {
        const response = await client.messages.parse(
          {
            model,
            max_tokens: 4000 + items.length * 600,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: batchPitchRequest(items) }],
            output_config: { format: zodOutputFormat(BatchSchema), effort: "low" },
          },
          { signal },
        );
        if (response.stop_reason === "refusal") throw new ProviderError("Claude declined to write these pitches", false);
        if (!response.parsed_output) throw new ProviderError("Claude returned pitches we couldn't read", true);
        return { items: response.parsed_output.items, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      } catch (err) {
        throw anthropicError(err);
      }
    },
    async writeFollowUps(items, signal) {
      try {
        const response = await client.messages.parse(
          {
            model,
            max_tokens: 2000 + items.length * 500,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: followUpRequest(items) }],
            output_config: { format: zodOutputFormat(FollowUpSchema), effort: "low" },
          },
          { signal },
        );
        if (response.stop_reason === "refusal") throw new ProviderError("Claude declined to write these follow-ups", false);
        if (!response.parsed_output) throw new ProviderError("Claude returned follow-ups we couldn't read", true);
        return { items: response.parsed_output.items, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      } catch (err) {
        throw anthropicError(err);
      }
    },
  };
}

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
 * The copywriter chosen by LLM_PROVIDER (gemini by default), or null when its
 * key is missing. Without a provider no drafts are written.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): CopyProvider | null {
  const choice = (env.LLM_PROVIDER || "gemini").toLowerCase();
  if (choice === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return null;
    return anthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-haiku-5-5");
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
  const choice = (env.LLM_PROVIDER || "gemini").toLowerCase();
  if (choice === "anthropic") return "LLM_PROVIDER is anthropic but ANTHROPIC_API_KEY is empty.";
  if (choice === "gemini") return "Add a free Gemini key as GEMINI_API_KEY in .env (from aistudio.google.com), then restart the app.";
  return `LLM_PROVIDER="${choice}" isn't supported. Use gemini, anthropic or ollama.`;
}
