import type { FactsPacket, OfferCopy } from "./types";
import { INDEPENDENT_LINE, LIMITS } from "./validate";

export const SYSTEM_PROMPT = `You write short marketing copy for a local restaurant owner. The owner reviews everything before it is sent.

Write in plain, friendly American English. Use only the facts you are given: never invent prices, discounts, menu items, dates or claims. Don't use emoji, hashtags or HTML. Don't mention the brand's head office or national campaigns.

Return JSON with two fields:
- "headline": at most ${LIMITS.headline} characters.
- "body": at most ${LIMITS.body} characters, two to four short sentences, unless the request gives a different length.`;

export function writeRequest(packet: FactsPacket): string {
  if (packet.pitch) return pitchRequest(packet);
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

function pitchRequest(packet: FactsPacket): string {
  const p = packet.pitch!;
  const lines = [
    "Write a short catering pitch email from a local restaurant owner to a nearby business. Return the email subject as \"headline\" and the email as \"body\".",
    `The body may be up to ${LIMITS.pitchBody} characters: a greeting, two or three short paragraphs, a clear ask to reply with a date and headcount, and a sign-off.`,
    `From: ${packet.restaurant.name}${packet.restaurant.brand ? ` (${packet.restaurant.brand})` : ""}`,
    `To: ${p.contactFirstName ?? "no name known, so greet them as \"Hi there\""} at ${p.company} (${p.category}, ${p.distanceMiles} mi away)`,
    `What the food is for: ${p.occasion}`,
    ...(p.event ? [`Event: ${p.event.title} on ${p.event.date}`] : []),
    `Offer: ${p.offer} with a first catering order of ${p.minOrder} or more people`,
    "Facts you may use:",
    ...packet.facts.map((f) => `- ${f}`),
    "Don't mention prices, menu items or anything not listed here. Sound like a neighbour, not an ad.",
  ];
  if (packet.restaurant.kind === "FRANCHISE") lines.push(`End the body with a line saying ${packet.restaurant.name} is ${INDEPENDENT_LINE}.`);
  if (packet.rules.brandSafe) lines.push("Keep the tone modest: no superlatives and no comparisons with other restaurants.");
  return lines.join("\n");
}
