import { templateProvider } from "./providers";
import { Semaphore, type RetryOptions, withRetry } from "./retry";
import { type CopyProvider, type FactsPacket, type OfferCopy, ProviderError } from "./types";
import { validateCopy } from "./validate";

export * from "./types";
export { providerFromEnv, templateProvider } from "./providers";
export { validateCopy } from "./validate";

/** At most two LLM calls at a time from this server, so bursts can't flood a provider. */
const limiter = new Semaphore(2);

export interface CallLog {
  provider: string;
  model: string;
  purpose: "write" | "rewrite";
  outcome: "ok" | "retried-ok" | "error" | "invalid-output";
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  error?: string;
}

export interface WriteOutcome extends OfferCopy {
  writtenBy: string;
  /** Set when the chosen provider failed and templates were used instead */
  fellBack: boolean;
  log: CallLog | null;
}

/**
 * Writes copy for one offer. Uses the configured provider with retries and a
 * timeout; if it fails or returns copy that breaks the rules, falls back to
 * the built-in template so the owner always gets a draft.
 */
export async function writeOfferCopy(
  provider: CopyProvider,
  packet: FactsPacket,
  retry?: RetryOptions,
): Promise<WriteOutcome> {
  const fallback = async (log: CallLog | null): Promise<WriteOutcome> => ({
    ...(await templateProvider.write(packet, new AbortController().signal)),
    writtenBy: "template",
    fellBack: provider !== templateProvider,
    log,
  });
  if (provider === templateProvider) return fallback(null);

  const started = Date.now();
  const base = { provider: provider.name, model: provider.model, purpose: "write" as const };
  try {
    const { value, attempts } = await limiter.run(() => withRetry((signal) => provider.write(packet, signal), retry));
    const durationMs = Date.now() - started;
    const tokens = { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
    const problems = validateCopy(value, packet);
    if (problems.length > 0) {
      return fallback({ ...base, ...tokens, outcome: "invalid-output", attempts, durationMs, error: problems.join(" ") });
    }
    return {
      headline: value.headline.trim(),
      body: value.body.trim(),
      writtenBy: `${provider.name}:${provider.model}`,
      fellBack: false,
      log: { ...base, ...tokens, outcome: attempts > 1 ? "retried-ok" : "ok", attempts, durationMs },
    };
  } catch (err) {
    return fallback({
      ...base,
      outcome: "error",
      attempts: (retry?.retries ?? 3) + 1,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type RewriteOutcome =
  | { ok: true; copy: OfferCopy; writtenBy: string; log: CallLog }
  | { ok: false; message: string; log: CallLog | null };

/** Rewrites a draft following the owner's instruction. Never falls back silently. */
export async function rewriteOfferCopy(
  provider: CopyProvider,
  packet: FactsPacket,
  current: OfferCopy,
  instruction: string,
  retry?: RetryOptions,
): Promise<RewriteOutcome> {
  if (!provider.rewrite) {
    return { ok: false, message: "AI rewriting needs an AI model. Set LLM_PROVIDER to ollama or anthropic.", log: null };
  }
  const started = Date.now();
  const base = { provider: provider.name, model: provider.model, purpose: "rewrite" as const };
  try {
    const { value, attempts } = await limiter.run(() =>
      withRetry((signal) => provider.rewrite!(packet, current, instruction, signal), retry),
    );
    const log = { ...base, attempts, durationMs: Date.now() - started, inputTokens: value.inputTokens, outputTokens: value.outputTokens };
    const problems = validateCopy(value, packet);
    if (problems.length > 0) {
      return { ok: false, message: `The rewrite broke a rule, so we kept your draft. ${problems[0]}`, log: { ...log, outcome: "invalid-output", error: problems.join(" ") } };
    }
    return {
      ok: true,
      copy: { headline: value.headline.trim(), body: value.body.trim() },
      writtenBy: `${provider.name}:${provider.model}`,
      log: { ...log, outcome: attempts > 1 ? "retried-ok" : "ok" },
    };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "The AI model didn't respond.";
    return {
      ok: false,
      message: `${message} Your draft is unchanged; try again in a minute.`,
      log: { ...base, outcome: "error", attempts: (retry?.retries ?? 3) + 1, durationMs: Date.now() - started, error: message },
    };
  }
}
