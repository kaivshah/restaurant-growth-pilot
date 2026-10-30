/** What the copywriter is given. This is the only data sent to an LLM. */
export interface FactsPacket {
  restaurant: { name: string; brand: string | null; kind: "FRANCHISE" | "INDEPENDENT" };
  offer: { key: string; title: string; schedule: string; audience: string; copyLabel: string };
  /** Facts the copy may state, word for word. */
  facts: string[];
  rules: {
    brandSafe: boolean;
    maxDiscountPct: number;
    /** Placeholder the message must contain, if any */
    codePlaceholder: "[CODE]" | null;
  };
  /** Set for catering pitch emails to a business */
  pitch?: PitchFacts;
}

/** What a catering pitch email may say about the lead and the offer. */
export interface PitchFacts {
  company: string;
  contactFirstName: string | null;
  /** e.g. "office", "event venue" */
  category: string;
  distanceMiles: number;
  /** e.g. "a free cookie platter" */
  offer: string;
  minOrder: number;
  occasion: string;
  event: { title: string; date: string } | null;
}

export interface OfferCopy {
  headline: string;
  body: string;
}

export interface WriteResult extends OfferCopy {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CopyProvider {
  /** e.g. "template", "ollama", "anthropic" */
  name: string;
  model: string;
  /** Most pitches or follow-ups per request (default 8) */
  batchSize?: number;
  write(packet: FactsPacket, signal: AbortSignal): Promise<WriteResult>;
  rewrite?(packet: FactsPacket, current: OfferCopy, instruction: string, signal: AbortSignal): Promise<WriteResult>;
  /** Several pitches from one restaurant in a single request (shared rules sent once) */
  writeMany?(items: { id: string; packet: FactsPacket }[], signal: AbortSignal): Promise<BatchResult>;
  /** The two follow-ups for several approved pitches in a single request */
  writeFollowUps?(items: FollowUpItem[], signal: AbortSignal): Promise<FollowUpResult>;
}

export interface FollowUpItem {
  id: string;
  packet: FactsPacket;
  first: { subject: string; body: string };
}

export interface FollowUpResult {
  items: { id: string; followup1: string; followup2: string }[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface BatchResult {
  items: (OfferCopy & { id: string })[];
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The AI provider rejected the setup itself (bad key, unknown model, no
 * access). Every further call would fail the same way, so jobs stop at once.
 */
export class AiConfigError extends Error {}

/**
 * The AI is busy or over its free limit. A job that hits this is put back in
 * the queue to try again later instead of writing anything without AI.
 */
export class AiBusyError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Thrown by providers so the retry loop knows what to do. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
