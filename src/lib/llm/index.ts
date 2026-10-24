import { Semaphore, type RetryOptions, withRetry } from "./retry";
import { AiConfigError, type CopyProvider, type FactsPacket, type OfferCopy, ProviderError, type WriteResult } from "./types";
import { validateCopy } from "./validate";

export * from "./types";
export { missingAiReason, providerFromEnv } from "./providers";
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

export type WriteOutcome =
  | { ok: true; copy: OfferCopy; writtenBy: string; log: CallLog }
  | { ok: false; retryable: boolean; retryAfterMs?: number; message: string; log: CallLog; fatal?: boolean };

/**
 * Writes copy for one offer with the configured AI provider, with retries and
 * a timeout. Copy that breaks a rule gets one chance to be fixed; there is no
 * pre-written fallback, so a failure is reported and the job tries later.
 */
export async function writeOfferCopy(provider: CopyProvider, packet: FactsPacket, retry?: RetryOptions): Promise<WriteOutcome> {
  const started = Date.now();
  const base = { provider: provider.name, model: provider.model, purpose: "write" as const };
  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const call = async (fn: (signal: AbortSignal) => Promise<WriteResult>) => {
    const r = await limiter.run(() => withRetry(fn, retry));
    attempts += r.attempts;
    inputTokens += r.value.inputTokens ?? 0;
    outputTokens += r.value.outputTokens ?? 0;
    return r.value;
  };
  const log = (outcome: CallLog["outcome"], error?: string): CallLog => ({ ...base, model: provider.model, outcome, attempts, inputTokens, outputTokens, durationMs: Date.now() - started, error });

  try {
    let value = await call((signal) => provider.write(packet, signal));
    let problems = validateCopy(value, packet);
    if (problems.length > 0 && provider.rewrite) {
      const broken = value;
      value = await call((signal) => provider.rewrite!(packet, broken, `Fix these problems and change nothing else: ${problems.join(" ")}`, signal));
      problems = validateCopy(value, packet);
    }
    if (problems.length > 0) {
      return { ok: false, retryable: false, message: `The AI's copy broke a rule: ${problems[0]}`, log: log("invalid-output", problems.join(" ")) };
    }
    return {
      ok: true,
      copy: { headline: value.headline.trim(), body: value.body.trim() },
      writtenBy: `${provider.name}:${provider.model}`,
      log: log(attempts > 1 ? "retried-ok" : "ok"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A bad key or retired model: every other draft would fail the same way.
    if (err instanceof AiConfigError) return { ok: false, retryable: false, fatal: true, message, log: log("error", message) };
    attempts = Math.max(attempts, (retry?.retries ?? 3) + 1);
    // Timeouts and rate limits fix themselves; a bad key or a refusal doesn't.
    const retryable = !(err instanceof ProviderError) || err.retryable;
    const retryAfterMs = err instanceof ProviderError ? err.retryAfterMs : undefined;
    return { ok: false, retryable, retryAfterMs, message, log: log("error", message) };
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
    return { ok: false, message: "This AI provider can't rewrite drafts.", log: null };
  }
  const started = Date.now();
  const base = { provider: provider.name, model: provider.model, purpose: "rewrite" as const };
  try {
    const { value, attempts } = await limiter.run(() =>
      withRetry((signal) => provider.rewrite!(packet, current, instruction, signal), retry),
    );
    const log = { ...base, model: provider.model, attempts, durationMs: Date.now() - started, inputTokens: value.inputTokens, outputTokens: value.outputTokens };
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
    const message = err instanceof ProviderError || err instanceof AiConfigError ? err.message : "The AI model didn't respond.";
    return {
      ok: false,
      message: `${message} Your draft is unchanged; try again in a minute.`,
      log: { ...base, outcome: "error", attempts: (retry?.retries ?? 3) + 1, durationMs: Date.now() - started, error: message },
    };
  }
}
