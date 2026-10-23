import { pick } from "./context";
import type { AnalystContext } from "./context";
import type { Evidence, Finding, Proposal } from "./schema";
import { estimateOfferCost } from "./tools";

/** What a tool actually returned during this run, keyed by tool call id. */
export type ToolLog = { id: string; name: string; input: unknown; output: unknown }[];

/** Read "rows[3].sales" or "drink_attach_pct" out of a tool result. */
export function readPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function close(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);
}

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

/** Each cited number must be exactly what the cited tool call returned. */
export function checkEvidence(evidence: Evidence[], log: ToolLog): string[] {
  const problems: string[] = [];
  for (const e of evidence) {
    const call = log.find((c) => c.id === e.tool_call_id);
    if (!call) {
      problems.push(`Cites tool call ${e.tool_call_id}, which never happened.`);
      continue;
    }
    const actual = readPath(call.output, e.field);
    if (typeof actual !== "number") problems.push(`"${e.label}": ${call.name} has no number at ${e.field}.`);
    else if (!close(e.value, actual)) problems.push(`"${e.label}": cited ${e.value}, but ${call.name} returned ${actual}.`);
  }
  return problems;
}

/**
 * Every dollar amount and percentage written in the text must match a number
 * the tools returned (or the offer's own value), so the explanation can't
 * contain invented figures. Small rounding is allowed.
 */
export function checkTextNumbers(text: string, log: ToolLog, extra: number[] = []): string[] {
  const known = [...collectNumbers(log.map((c) => c.output)), ...extra];
  const problems: string[] = [];
  for (const m of text.matchAll(/(\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)/g)) {
    const n = parseFloat(m[0].replace(/[$,%\s]/g, ""));
    const ok = known.some((k) => Math.abs(k - n) <= Math.max(1, Math.abs(k) * 0.01));
    if (!ok) problems.push(`Says "${m[0].trim()}", which doesn't match any number in the data.`);
  }
  return problems;
}

function openWindow(ctx: AnalystContext): { first: number; last: number } | null {
  const dp = pick(ctx, "dayPart");
  if (!dp) return null;
  const open = dp.hours.filter((h) => h.week.sales > 0).map((h) => h.hour24);
  return open.length ? { first: Math.min(...open), last: Math.max(...open) + 1 } : null;
}

export function checkProposal(p: Proposal, ctx: AnalystContext, log: ToolLog): string[] {
  const problems: string[] = [...checkEvidence(p.evidence, log)];
  const extra = [p.value_usd, p.percent_off, p.duration_weeks, p.start_hour, p.end_hour, ctx.rules.maxDiscountPct].filter(
    (x): x is number => typeof x === "number",
  );
  problems.push(...checkTextNumbers(`${p.title} ${p.why} ${p.expected_effect}`, log, extra));

  const brandSafe = ctx.rules.promoApproval !== "YES";
  const priceCut = p.mechanic === "amount_off" || p.mechanic === "percent_off" || p.mechanic === "bundle_price";
  if (priceCut && brandSafe) problems.push("Price cuts aren't allowed until the owner confirms their brand allows local promotions.");
  if (priceCut && !ctx.rules.allowPercentOff) problems.push("The owner hasn't allowed price cuts.");
  if ((p.mechanic === "free_item" || p.mechanic === "catering_promo") && !ctx.rules.allowFreeExtra) {
    problems.push("The owner hasn't allowed free extras.");
  }

  // Generosity must fit the owner's discount limit.
  if (p.mechanic === "percent_off") {
    if (p.percent_off === undefined) problems.push("A % off offer needs percent_off.");
    else if (p.percent_off > ctx.rules.maxDiscountPct) problems.push(`${p.percent_off}% off is over the ${ctx.rules.maxDiscountPct}% limit.`);
  } else if (p.mechanic !== "catering_promo") {
    if (p.value_usd === undefined) {
      problems.push("The offer's dollar value is missing, so we can't check it against the discount limit.");
    } else {
      const est = estimateOfferCost(ctx, { mechanic: p.mechanic, value_usd: p.value_usd });
      if (est.within_limit === false) problems.push(`Worth ${est.value_pct_of_ticket}% of an average order, over the ${ctx.rules.maxDiscountPct}% limit.`);
    }
  }

  if (p.end_hour <= p.start_hour) problems.push("The offer ends before it starts.");
  const window = openWindow(ctx);
  if (window && (p.start_hour < window.first || p.end_hour > window.last)) {
    problems.push(`Runs outside the hours the store has sales (${window.first}:00–${window.last}:00).`);
  }
  if (p.audience === "catering_leads" && p.mechanic !== "catering_promo") problems.push("Offers for catering leads must be catering promotions.");
  return problems;
}

export function checkFinding(f: Finding, log: ToolLog): string[] {
  return [...checkEvidence(f.evidence, log), ...checkTextNumbers(`${f.title} ${f.detail}`, log)];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 2);

/** Rough duplicate test on titles, e.g. "Free cookie with footlong" vs "Free cookie with any footlong". */
export function similar(a: string, b: string) {
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.min(A.size, B.size) >= 0.75;
}
