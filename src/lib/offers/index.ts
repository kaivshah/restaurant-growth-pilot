import type { HourBar } from "@/lib/insights";

/**
 * The shape of an offer idea in the Approval Inbox. Every idea comes from the
 * AI analyst, which studies the uploaded reports; there are no fixed ideas.
 */

export interface OfferRules {
  promoApproval: "YES" | "NO" | "UNSURE";
  maxDiscountPct: number;
  allowFreeExtra: boolean;
  allowPercentOff: boolean;
}

export interface Citation {
  label: string;
  value: number;
  source: string;
}

export type OfferEvidence =
  | { kind: "hourly"; bars: HourBar[]; highlight: number[]; caption: string }
  | { kind: "citations"; items: Citation[] };

export interface OfferCandidate {
  /** "ai-<slug>" */
  key: string;
  source: "RULES" | "AI_ANALYST";
  confidence: "low" | "medium" | "high" | null;
  category: string;
  title: string;
  schedule: string;
  why: string;
  audience: string;
  cost: string;
  measure: string;
  checks: string[];
  copyLabel: string;
  /** Short facts the copywriter may use, word for word */
  facts: string[];
  /** Whether the message must include the [CODE] placeholder */
  needsCode: boolean;
  evidence: OfferEvidence | null;
}

export function isBrandSafe(rules: OfferRules) {
  return rules.promoApproval !== "YES";
}

/** Value of a giveaway as a share of the average order, in whole percent. */
export function valueSharePct(itemValue: number, averageTicket: number) {
  return averageTicket > 0 ? Math.round((itemValue / averageTicket) * 100) : Infinity;
}
