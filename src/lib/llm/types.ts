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
  write(packet: FactsPacket, signal: AbortSignal): Promise<WriteResult>;
  rewrite?(packet: FactsPacket, current: OfferCopy, instruction: string, signal: AbortSignal): Promise<WriteResult>;
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
