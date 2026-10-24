import type { LocalEvent } from "@/lib/events";
import { domainOf, isUsefulDomain } from "@/lib/geo";
import type { Place } from "@/lib/places";

/**
 * Fit scores for catering leads and events. Plain, explainable rules; the AI
 * lead analyst decides which of the top-scored leads to actually pitch.
 */

const CATEGORY_WEIGHT: Record<string, number> = { office: 30, coworking: 28, school: 22, clinic: 20, venue: 18, gym: 12, other: 8 };
const CATEGORY_LABEL: Record<string, string> = { office: "Office", coworking: "Coworking space", school: "School", clinic: "Clinic", venue: "Event venue", gym: "Gym", other: "Business" };

/** Skipping a pitch for one of these (except a wrong contact) keeps the business out of future pitches. */
export const LEAD_SKIP_REASONS = ["Too far", "Wrong kind of business", "Already a customer", "Contact looks wrong"];

export function categoryLabel(c: string) {
  return CATEGORY_LABEL[c] ?? "Business";
}

export function scoreLead(p: Place, distanceMiles: number, radiusMiles: number): { score: number; reasons: string[]; excluded: string | null } {
  if (p.businessStatus === "CLOSED_PERMANENTLY") return { score: 0, reasons: ["Permanently closed"], excluded: "Permanently closed" };
  if (distanceMiles > radiusMiles) return { score: 0, reasons: [`${distanceMiles} mi away, outside your ${radiusMiles} mi radius`], excluded: "Outside the delivery radius" };

  const reasons = [`${categoryLabel(p.category)} · ${distanceMiles} mi away`];
  let score = CATEGORY_WEIGHT[p.category] ?? 8;
  score += Math.round(30 * (1 - distanceMiles / radiusMiles));
  if (isUsefulDomain(domainOf(p.website))) {
    score += 15;
    reasons.push("Has a website, so we can look for a contact");
  } else if (p.website) reasons.push("Only a social media page, so no contact lookup");
  if (p.businessStatus === "OPERATIONAL") score += 10;
  else if (p.businessStatus === "CLOSED_TEMPORARILY") {
    score -= 20;
    reasons.push("Temporarily closed");
  }
  if (p.ratingCount) {
    score += Math.min(15, Math.round(Math.log10(p.ratingCount + 1) * 6));
    if (p.ratingCount >= 100) reasons.push(`${p.ratingCount} Google reviews, a sign of a busy place`);
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, excluded: null };
}

const EVENT_WEIGHT: Record<string, number> = { conference: 35, expo: 35, corporate: 35, sports: 25, community: 20, school: 20, concert: 8, other: 10 };

/** Events worth reaching out about: inside the radius and 7–60 days ahead. */
export function scoreEvent(
  e: LocalEvent,
  distanceMiles: number | null,
  radiusMiles: number,
  now = new Date(),
): { score: number; reasons: string[]; excluded: string | null } {
  const days = Math.round((e.startsAt.getTime() - now.getTime()) / 86_400_000);
  if (days < 7) return { score: 0, reasons: [`Starts in ${days} days, too soon to arrange catering`], excluded: "Too soon" };
  if (days > 60) return { score: 0, reasons: [`Starts in ${days} days`], excluded: "Too far ahead" };
  if (distanceMiles !== null && distanceMiles > radiusMiles) return { score: 0, reasons: [`${distanceMiles} mi away`], excluded: "Outside the delivery radius" };

  const reasons = [`${e.category[0].toUpperCase()}${e.category.slice(1)} in ${days} days`];
  let score = EVENT_WEIGHT[e.category] ?? 10;
  if (e.attendance) {
    score += Math.min(35, Math.round(Math.log10(e.attendance) * 11));
    reasons.push(`About ${e.attendance.toLocaleString("en-US")} expected`);
  }
  score += days >= 14 && days <= 42 ? 15 : 5;
  if (distanceMiles !== null) {
    score += Math.round(15 * (1 - distanceMiles / radiusMiles));
    reasons.push(`${distanceMiles} mi away`);
  }
  if (!e.venueName) reasons.push("No venue listed, so there's no one to contact yet");
  return { score: Math.max(0, Math.min(100, score)), reasons, excluded: null };
}
