import type { Citation, OfferCandidate } from "@/lib/offers";
import type { AnalystContext } from "./context";
import { DAYS, type Evidence, type Proposal } from "./schema";
import { estimateOfferCost } from "./tools";
import type { ToolLog } from "./verify";

const DAY_WORDS: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

/** ["Mon","Tue","Wed"] → "Mon–Wed"; ["Sat","Mon"] → "Sat, Mon"; all → "Every day". */
export function daysShort(days: string[]): string {
  const sorted = DAYS.filter((d) => days.includes(d));
  if (sorted.length === 7) return "Every day";
  const idx = sorted.map((d) => DAYS.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return contiguous && sorted.length > 2 ? `${sorted[0]}–${sorted.at(-1)}` : sorted.join(", ");
}

function daysLong(days: string[]): string {
  const sorted = DAYS.filter((d) => days.includes(d));
  if (sorted.length === 7) return "Every day";
  const idx = sorted.map((d) => DAYS.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${DAY_WORDS[sorted[0]]} to ${DAY_WORDS[sorted.at(-1)!]}`;
  return sorted.map((d) => DAY_WORDS[d]).join(", ");
}

/** 15 → "3 pm", 12 → "noon", 24 → "midnight" */
function hourWord(h: number) {
  if (h === 12) return "noon";
  if (h === 0 || h === 24) return "midnight";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

export function hoursText(start: number, end: number) {
  const s = hourWord(start);
  const e = hourWord(end);
  const sameHalf = start >= 12 && end > 12 && start !== 12 && end !== 24;
  return sameHalf ? `${s.replace(" pm", "")}–${e}` : `${s}–${e}`;
}

const money = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;

const AUDIENCE_TEXT: Record<Proposal["audience"], string> = {
  email_list: "Your email list",
  in_store_qr: "In-store customers, via the counter QR card",
  email_and_qr: "Your email list, plus the counter QR card",
  catering_leads: "Nearby businesses that order catering",
};

const CATEGORY: Record<Proposal["mechanic"], string> = {
  free_item: "Free extra",
  amount_off: "Money off",
  percent_off: "Percent off",
  bundle_price: "Bundle deal",
  catering_promo: "Catering",
};

function sourceOf(e: Evidence, log: ToolLog): string {
  const out = log.find((c) => c.id === e.tool_call_id)?.output as { source?: string | string[] } | undefined;
  const s = out?.source;
  return Array.isArray(s) ? s.join("; ") : (s ?? "Your reports");
}

export function citations(evidence: Evidence[], log: ToolLog): Citation[] {
  return evidence.map((e) => ({ label: e.label, value: e.value, source: sourceOf(e, log) }));
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Turns a verified AI proposal into an inbox offer, the same shape the rule ideas use. */
export function proposalToOffer(p: Proposal, ctx: AnalystContext, log: ToolLog): OfferCandidate {
  const est = p.mechanic === "catering_promo" ? null : estimateOfferCost(ctx, { mechanic: p.mechanic, value_usd: p.value_usd, percent_off: p.percent_off });
  const needsCode = p.audience !== "in_store_qr" && p.audience !== "catering_leads";
  const brandSafe = ctx.rules.promoApproval !== "YES";
  const when = `${daysShort(p.days)}, ${hoursText(p.start_hour, p.end_hour)}`;
  const cost =
    p.mechanic === "percent_off"
      ? `${p.percent_off}% off qualifying orders`
      : p.value_usd !== undefined
        ? `${money(p.value_usd)} per use${est?.value_pct_of_ticket != null ? ` (${est.value_pct_of_ticket}% of an average order)` : ""}`
        : "Set by your catering prices";

  return {
    key: `ai-${slug(p.title)}`,
    source: "AI_ANALYST",
    confidence: p.confidence,
    category: CATEGORY[p.mechanic],
    title: p.title,
    schedule: `${when} · for ${p.duration_weeks} ${p.duration_weeks === 1 ? "week" : "weeks"}`,
    why: p.why,
    audience: AUDIENCE_TEXT[p.audience],
    cost,
    measure: p.expected_effect,
    checks: [
      ...(p.mechanic === "catering_promo" ? [] : [`Within your ${ctx.rules.maxDiscountPct}% limit`]),
      "Numbers checked against your reports",
      ...(needsCode ? ["Unique redemption code"] : []),
      `Ends after ${p.duration_weeks} ${p.duration_weeks === 1 ? "week" : "weeks"}`,
      ...(brandSafe ? ["Check with your brand before sending"] : []),
    ],
    copyLabel: p.audience === "in_store_qr" ? "QR card headline" : "Email subject",
    facts: [
      p.title,
      `${daysLong(p.days)}, ${hoursText(p.start_hour, p.end_hour)}`,
      `Valid for ${p.duration_weeks} ${p.duration_weeks === 1 ? "week" : "weeks"}`,
      ...(p.qualifying_purchase && p.qualifying_purchase.toLowerCase() !== "none" ? [`With ${p.qualifying_purchase}`] : []),
      ...(needsCode ? ["Show the code at the counter"] : []),
    ],
    needsCode,
    evidence: { kind: "citations", items: citations(p.evidence, log) },
  };
}
