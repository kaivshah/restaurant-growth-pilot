import { randomInt } from "node:crypto";
import { fromPacific, pacificParts } from "@/lib/outreach/schedule";

/**
 * Personal offer codes and the small rules around them. Pure functions, so
 * they're easy to test; the database work is in ./index.ts.
 */

/** No 0/O or 1/I: easy to read out at the counter. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** A code like "K7QM-4TZ9" (about 10^12 possibilities). */
export function makeCode(rand: (max: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What staff typed ("k7qm 4tz9", "K7QM4TZ9") in the stored form, or null if it can't be a code. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8 || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** How long a code works, from the offer's facts ("Valid for 4 weeks"). */
export function validityDays(facts: string[], fallback = 14): number {
  for (const f of facts) {
    const m = f.match(/valid for (\d+)\s*(day|week|month)s?/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      return n * (unit === "day" ? 1 : unit === "week" ? 7 : 30);
    }
  }
  return fallback;
}

/** Codes work until 11:59 pm San Diego time on their last day. */
export function lastMoment(from: Date, days: number): Date {
  const p = pacificParts(new Date(from.getTime() + days * 86_400_000));
  return fromPacific(p.y, p.m, p.d, 23, 59);
}

/** The welcome gift lasts a month so people have time to come back. */
export const WELCOME_DAYS = 30;

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });

/**
 * One customer's copy of an offer email: their name, their code where the
 * writer put [CODE] (or at the end), and the last day it works.
 */
export function personalize(body: string, code: string, validUntil: Date, firstName?: string | null): string {
  let text = body.trim();
  const name = firstName?.trim();
  if (name && !/^(hi|hello|hey|dear)\b/i.test(text)) text = `Hi ${name},\n\n${text}`;
  const until = `Valid until ${shortDate(validUntil)}.`;
  if (text.includes("[CODE]")) return `${text.replaceAll("[CODE]", code)}\n\n${until}`;
  return `${text}\n\nYour code: ${code}\nShow it at the counter. ${until}`;
}

export type Audience = "all" | "regulars" | "lapsed";

export const AUDIENCES: { key: Audience; label: string; help: string }[] = [
  { key: "all", label: "Everyone on the list", help: "All customers who agreed to get offers" },
  { key: "regulars", label: "Regulars", help: "Used 3 or more codes in the last 60 days" },
  { key: "lapsed", label: "Haven't been back", help: "Joined over 30 days ago and no code used in the last 30 days" },
];

export interface SegmentInput {
  createdAt: Date;
  /** When each of their codes was used */
  redeemed: Date[];
}

const DAY = 86_400_000;

export function inAudience(c: SegmentInput, audience: Audience, now = new Date()): boolean {
  if (audience === "all") return true;
  if (audience === "regulars") return c.redeemed.filter((d) => d.getTime() >= now.getTime() - 60 * DAY).length >= 3;
  return c.createdAt.getTime() < now.getTime() - 30 * DAY && !c.redeemed.some((d) => d.getTime() >= now.getTime() - 30 * DAY);
}

/**
 * Offers sent by email carry a personal code. Counter-only ideas (the QR
 * card, catering promos) aren't emailed, and the welcome gift goes out by
 * itself to each new sign-up.
 */
export function emailable(draft: { kind: string; offerKey: string; needsCode: boolean }): "list" | "welcome" | null {
  if (draft.kind !== "CUSTOMER_OFFER") return null;
  if (draft.offerKey === "welcome") return "welcome";
  return draft.needsCode ? "list" : null;
}

export type RedeemState = "ok" | "used" | "expired" | "not-yet" | "not-found" | "invalid";

export function redeemState(code: { validFrom: Date; validUntil: Date; redeemedAt: Date | null } | null, now = new Date()): RedeemState {
  if (!code) return "not-found";
  if (code.redeemedAt) return "used";
  if (now < code.validFrom) return "not-yet";
  if (now > code.validUntil) return "expired";
  return "ok";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (s: string) => EMAIL.test(s.trim()) && s.length <= 200;
