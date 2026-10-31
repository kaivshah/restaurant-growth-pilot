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
    "Rewrite the draft to follow that request, keeping every rule above. Return the whole email (headline and body, including the greeting and sign-off), not just the part you changed.",
  ].join("\n");
}

// Pitch prompts are split into rules that are the same for every pitch from
// this restaurant (sent first, once per batch, and a stable prefix that
// providers can cache) and the facts of each pitch.

/** What every pitch from this restaurant must follow. */
export function pitchRules(packet: FactsPacket): string {
  const lines = [
    "Write short catering pitch emails from a local restaurant owner to nearby businesses. For each, the email subject is \"headline\" and the email is \"body\".",
    `A body may be up to ${LIMITS.pitchBody} characters: a greeting, two or three short paragraphs, a clear ask to reply with a date and headcount, and a sign-off.`,
    `From: ${packet.restaurant.name}${packet.restaurant.brand ? ` (${packet.restaurant.brand})` : ""}`,
    "Use only the facts given for each email. Don't mention prices, menu items or anything not listed. Sound like a neighbour, not an ad.",
  ];
  if (packet.restaurant.kind === "FRANCHISE") lines.push(`End every body with a line saying ${packet.restaurant.name} is ${INDEPENDENT_LINE}.`);
  if (packet.rules.brandSafe) lines.push("Keep the tone modest: no superlatives and no comparisons with other restaurants.");
  return lines.join("\n");
}

/** The facts of one pitch. */
export function pitchFacts(packet: FactsPacket): string {
  const p = packet.pitch!;
  return [
    `To: ${p.contactFirstName ?? 'no name known, so greet them as "Hi there"'} at ${p.company} (${p.category}, ${p.distanceMiles} mi away)`,
    `What the food is for: ${p.occasion}`,
    ...(p.event ? [`Event: ${p.event.title} on ${p.event.date}`] : []),
    `Offer: ${p.offer} with a first catering order of ${p.minOrder} or more people`,
    "Facts you may use:",
    ...packet.facts.map((f) => `- ${f}`),
  ].join("\n");
}

function pitchRequest(packet: FactsPacket): string {
  return `${pitchRules(packet)}\n\nWrite one email.\n${pitchFacts(packet)}`;
}

/** Many pitches in one request: the shared rules once, then each pitch's facts with its id. */
export function batchPitchRequest(packets: { id: string; packet: FactsPacket }[]): string {
  return [
    pitchRules(packets[0].packet),
    "",
    `Write ${packets.length} separate emails, one per item below. Return {"items": [{"id", "headline", "body"}]} with the same ids.`,
    ...packets.map(({ id, packet }) => `\n### ${id}\n${pitchFacts(packet)}`),
  ].join("\n");
}

/** Follow-ups for approved pitches, several per request: the facts and the first email of each. */
export function followUpRequest(items: { id: string; packet: FactsPacket; first: { subject: string; body: string } }[]): string {
  const name = items[0].packet.restaurant.name;
  return [
    `Write two short follow-up emails for each catering pitch below, from ${name}. They are sent in the same email thread only if there's no reply:`,
    "- followup1, after 4 days: a friendly nudge in two or three sentences that adds one helpful detail from the facts (no new facts).",
    "- followup2, after 10 days: a last, polite check-in in one or two sentences that says you won't email again unless they'd like to hear back.",
    `Use only the facts given. No new offers, prices, menu items or claims. Don't repeat the whole pitch. Plain text: a greeting, the message, and "The team at ${name}".`,
    'Return {"items": [{"id", "followup1", "followup2"}]} with the same ids.',
    ...items.map(({ id, packet, first }) => `\n### ${id}\n${pitchFacts(packet)}\nFirst email subject: ${first.subject}\nFirst email:\n${first.body}`),
  ].join("\n");
}
