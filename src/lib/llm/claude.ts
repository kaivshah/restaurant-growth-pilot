import Anthropic from "@anthropic-ai/sdk";
import { parseRetryAfter } from "./retry";
import { AiConfigError, ProviderError } from "./types";

/**
 * What every Claude request in the app shares: one client per key (so jobs
 * reuse warm HTTP connections instead of opening new ones), the default
 * model, prompt-cache markers, server-side fallbacks and error mapping.
 */

/** The model used unless ANTHROPIC_MODEL / ANALYST_MODEL name another. */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

const clients = new Map<string, Anthropic>();

/** One client per API key for the life of the process. Retries are the caller's job (withRetry / the job queue). */
export function claudeClient(apiKey: string): Anthropic {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 0 });
    clients.set(apiKey, client);
  }
  return client;
}

/** Models that accept server-side fallbacks: a declined request is re-run on a suitable model inside the same call. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function fallbackParams(model: string) {
  return FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"] as string[], fallbacks: "default" as const } : {};
}

/**
 * A system prompt that's the same on every request, marked for the 1-hour
 * prompt cache: requests within the hour (other pitches, other restaurants'
 * daily plans) read it at a fraction of the price instead of paying for it
 * again. Below the model's minimum cacheable size the marker is simply ignored.
 */
export function cachedSystem(...parts: string[]): Anthropic.Beta.BetaTextBlockParam[] {
  return parts.map((text, i) => ({ type: "text" as const, text, ...(i === parts.length - 1 ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}) }));
}

/** Input tokens including the ones read from or written to the cache, for the usage log. */
export function inputTokensOf(usage: { input_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Turns SDK errors into the app's: busy (try later), broken setup (stop), or a plain failure. */
export function claudeError(err: unknown): ProviderError | AiConfigError {
  if (err instanceof ProviderError || err instanceof AiConfigError) return err;
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("Claude rate limit reached", true, parseRetryAfter(err.headers?.get("retry-after")));
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiConfigError("Claude API key is missing or invalid. Check ANTHROPIC_API_KEY in .env.");
  }
  if (err instanceof Anthropic.NotFoundError) return new AiConfigError(`Claude model not found: ${err.message}. Check ANTHROPIC_MODEL / ANALYST_MODEL in .env.`);
  // 500, 529 overloaded, timeouts and dropped connections all clear up on their own.
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) return new ProviderError(`Claude unavailable: ${err.message}`, true);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude error ${err.status}: ${err.message}`, (err.status ?? 0) >= 500);
  return new ProviderError(err instanceof Error ? err.message : String(err), false);
}
