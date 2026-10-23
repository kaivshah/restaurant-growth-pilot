import type { FactsPacket, OfferCopy } from "./types";

export const LIMITS = { headline: 90, body: 600 };

/**
 * Checks LLM output before it can reach the inbox. Returns a list of
 * problems; an empty list means the copy is safe to show the owner.
 */
export function validateCopy(copy: OfferCopy, packet: FactsPacket): string[] {
  const problems: string[] = [];
  const headline = copy.headline?.trim() ?? "";
  const body = copy.body?.trim() ?? "";
  if (!headline) problems.push("Headline is empty.");
  if (!body) problems.push("Message is empty.");
  if (headline.length > LIMITS.headline) problems.push(`Headline is longer than ${LIMITS.headline} characters.`);
  if (body.length > LIMITS.body) problems.push(`Message is longer than ${LIMITS.body} characters.`);

  const allowedText = [packet.offer.title, packet.offer.schedule, ...packet.facts].join(" ");
  const text = `${headline} ${body}`;

  // Every price must come from the facts, so the AI can't invent a deal.
  for (const price of text.match(/\$\s?\d+(?:\.\d{1,2})?/g) ?? []) {
    if (!allowedText.includes(price.replace(/\s/g, ""))) problems.push(`Mentions ${price}, which isn't in the offer.`);
  }
  // Same for percentages, and none above the owner's limit.
  for (const pct of text.match(/\d+(?:\.\d+)?\s?%/g) ?? []) {
    const n = parseFloat(pct);
    if (!allowedText.includes(pct.replace(/\s/g, ""))) problems.push(`Mentions ${pct}, which isn't in the offer.`);
    else if (n > packet.rules.maxDiscountPct) problems.push(`Mentions ${pct}, above the ${packet.rules.maxDiscountPct}% limit.`);
  }
  if (packet.rules.codePlaceholder && !body.includes(packet.rules.codePlaceholder)) {
    problems.push(`Message must include ${packet.rules.codePlaceholder} where the redemption code goes.`);
  }
  if (/<[a-z][^>]*>/i.test(text)) problems.push("Contains HTML.");
  return problems;
}
