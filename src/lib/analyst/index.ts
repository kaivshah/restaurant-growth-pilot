import type { OfferCandidate } from "@/lib/offers";
import type { AnalystContext } from "./context";
import { fakeAnalyst } from "./fake";
import { fakeLeadAnalyst } from "./leads/fake";
import { type AnalystModel, claudeAnalyst, ollamaAnalyst } from "./models";
import type { AnalysisOutcome } from "./run";
import { similar } from "./verify";

export type { AnalystContext } from "./context";
export { runAnalysis } from "./run";
export { runLeadAnalysis, defaultPitches } from "./leads";
export type { LeadContext, LeadInfo, EventInfo, LeadOutcome, Pitch } from "./leads";
export type { AnalysisOutcome, Rejected } from "./run";
export { proposalToOffer, citations } from "./to-offer";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The analyst chosen by ANALYST_PROVIDER, or null when it's off (rule ideas
 * only). The purpose only matters for the scripted fake.
 */
export function analystFromEnv(purpose: "offers" | "leads" = "offers", env: NodeJS.ProcessEnv = process.env): AnalystModel | null {
  const choice = (env.ANALYST_PROVIDER ?? "off").toLowerCase();
  if (choice === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      console.warn("ANALYST_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set; the analyst is off.");
      return null;
    }
    const effort = EFFORTS.find((e) => e === env.ANALYST_EFFORT);
    return claudeAnalyst(env.ANTHROPIC_API_KEY, env.ANALYST_MODEL || "claude-opus-5-5", effort);
  }
  if (choice === "ollama") {
    return ollamaAnalyst(env.OLLAMA_URL || "http://localhost:11434", env.ANALYST_MODEL || env.OLLAMA_MODEL || "qwen2.5:7b-instruct");
  }
  if (choice === "fake" && env.NODE_ENV !== "production") return purpose === "leads" ? fakeLeadAnalyst() : fakeAnalyst();
  return null;
}

/** USD per million tokens (input, output), for the cost estimate shown in the analysis log. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return Math.round(((inputTokens * p[0] + outputTokens * p[1]) / 1_000_000) * 10_000) / 10_000;
}

/**
 * Standard ideas plus the analyst's: the AI can drop or replace a standard
 * idea, and anything too close to an AI idea is left out.
 */
export function mergeIdeas(baseline: OfferCandidate[], aiOffers: OfferCandidate[], outcome: Pick<AnalysisOutcome, "baselineDecisions" | "proposals">): OfferCandidate[] {
  const replaced = new Set(outcome.proposals.map((p) => p.baseline_key).filter(Boolean));
  const dropped = new Set(outcome.baselineDecisions.filter((d) => d.action === "drop").map((d) => d.key));
  const kept = baseline.filter((b) => !dropped.has(b.key) && !replaced.has(b.key) && !aiOffers.some((a) => similar(a.title, b.title)));
  return [...kept, ...aiOffers];
}

export function buildContext(
  restaurant: AnalystContext["restaurant"] & AnalystContext["rules"],
  reports: AnalystContext["reports"],
  pastDecisions: AnalystContext["pastDecisions"],
): AnalystContext {
  return {
    restaurant: {
      name: restaurant.name,
      kind: restaurant.kind,
      brand: restaurant.brand,
      radiusMiles: restaurant.radiusMiles,
      minCateringOrder: restaurant.minCateringOrder,
      openingHours: restaurant.openingHours,
    },
    rules: {
      promoApproval: restaurant.promoApproval,
      maxDiscountPct: restaurant.maxDiscountPct,
      allowFreeExtra: restaurant.allowFreeExtra,
      allowFreeDelivery: restaurant.allowFreeDelivery,
      allowPercentOff: restaurant.allowPercentOff,
      allowBogo: restaurant.allowBogo,
      useBrandCateringMenu: restaurant.useBrandCateringMenu,
    },
    reports,
    pastDecisions,
  };
}
