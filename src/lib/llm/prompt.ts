import type { FactsPacket, OfferCopy } from "./types";
import { LIMITS } from "./validate";

export const SYSTEM_PROMPT = `You write short marketing copy for a local restaurant owner. The owner reviews everything before it is sent.

Write in plain, friendly American English. Use only the facts you are given: never invent prices, discounts, menu items, dates or claims. Don't use emoji, hashtags or HTML. Don't mention the brand's head office or national campaigns.

Return JSON with two fields:
- "headline": at most ${LIMITS.headline} characters.
- "body": at most ${LIMITS.body} characters, two to four short sentences.`;

export function writeRequest(packet: FactsPacket): string {
  const lines = [
    `Restaurant: ${packet.restaurant.name}${packet.restaurant.kind === "FRANCHISE" && packet.restaurant.brand ? ` (an independently owned ${packet.restaurant.brand} franchise)` : ""}`,
    `Offer: ${packet.offer.title}`,
    `When: ${packet.offer.schedule}`,
    `Who receives it: ${packet.offer.audience}`,
    `The headline is used as the ${packet.offer.copyLabel.toLowerCase()}.`,
    "Facts you may use:",
    ...packet.facts.map((f) => `- ${f}`),
  ];
  if (packet.rules.codePlaceholder) {
    lines.push(`The body must include the exact text ${packet.rules.codePlaceholder} where the customer's redemption code goes.`);
  }
  if (packet.rules.brandSafe) lines.push("Keep the tone modest: no superlatives and no comparisons with other restaurants.");
  return lines.join("\n");
}

export function rewriteRequest(packet: FactsPacket, current: OfferCopy, instruction: string): string {
  return [
    writeRequest(packet),
    "",
    "Current draft:",
    `Headline: ${current.headline}`,
    `Body: ${current.body}`,
    "",
    `The owner asked: "${instruction.slice(0, 300)}"`,
    "Rewrite the draft to follow that request, keeping every rule above.",
  ].join("\n");
}
