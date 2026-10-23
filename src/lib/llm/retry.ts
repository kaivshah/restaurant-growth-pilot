import { ProviderError } from "./types";

export interface RetryOptions {
  /** Retries after the first try (3 → up to 4 attempts) */
  retries?: number;
  baseDelayMs?: number;
  /** Longest single wait we accept, including a provider's retry-after */
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn with a per-attempt timeout. Retries rate limits (429), server
 * errors and timeouts with exponential backoff plus jitter (≈1s, 2s, 4s),
 * honouring a provider's retry-after. Never retries other errors.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await fn(controller.signal);
      return { value, attempts: attempt };
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const retryable = timedOut || (err instanceof ProviderError && err.retryable);
      if (!retryable || attempt > retries) {
        if (timedOut) throw new ProviderError(`Timed out after ${timeoutMs / 1000}s`, true);
        throw err;
      }
      const backoff = base * 2 ** (attempt - 1) * (0.75 + random() * 0.5);
      const hinted = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const wait = Math.min(maxDelay, Math.max(backoff, hinted ?? 0));
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Limits how many LLM calls run at once in this server process. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Parse a retry-after header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
