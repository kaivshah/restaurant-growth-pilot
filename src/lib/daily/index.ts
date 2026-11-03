import { createHash } from "node:crypto";
import type { Restaurant } from "@prisma/client";
import type { EventInfo, LeadInfo } from "@/lib/analyst";
import { db } from "@/lib/db";
import { type Insights, computeInsights } from "@/lib/insights";
import { AiConfigError } from "@/lib/llm/types";
import { nextPacificMidnight, pacificDay } from "@/lib/llm/usage";
import type { ParsedReport } from "@/lib/reports";

/**
 * The day's working set for the AI, built once and reused all day:
 *
 *   reports ─▶ store brief (a few lines, numbers worked out here, not by the AI)
 *   Google Places + event APIs (already saved by the scan) ─▶ compact lists
 *
 * Deals, the top-20 catering picks and every pitch read from this instead of
 * the raw reports and API results, so each AI request carries only what it
 * needs. It's rebuilt the next day, or sooner if the reports, the scan or the
 * owner's rules change.
 */

export interface DailyContext {
  day: string;
  hash: string;
  builtAt: string;
  /** Short facts about the store, for the AI and for pitches */
  brief: string[];
  leads: LeadInfo[];
  events: EventInfo[];
}

/** Businesses and events passed to the AI: the best 80 and the next 30 days' 25 best. */
export const DAILY_LIMITS = { leads: 80, events: 25 };

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const hourName = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

/**
 * The store in a few lines, from its reports. Only what helps choose deals
 * and pitch catering: sales and traffic, the quiet hours (when the kitchen
 * can prepare catering), the lunch peak, catering's share so far, and how
 * much is already given away in discounts.
 */
export function storeBrief(ins: Insights, restaurant: Pick<Restaurant, "minCateringOrder" | "radiusMiles" | "openingHours">): string[] {
  const out: string[] = [];
  if (ins.netSales != null) out.push(`Weekly net sales about ${money(ins.netSales)}${ins.customers ? ` from about ${ins.customers.toLocaleString("en-US")} customers` : ""}${ins.averageTicket ? `, average order $${ins.averageTicket.toFixed(2)}` : ""}.`);
  if (ins.cateringSales != null && ins.netSales) {
    const pct = Math.round((ins.cateringSales / ins.netSales) * 100);
    out.push(ins.cateringSales > 0 ? `Catering is ${pct}% of sales (${money(ins.cateringSales)} a week).` : "No catering sales yet: every catering order is new business.");
  }
  if (ins.hourly) {
    const open = ins.hourly.bars.filter((b) => b.sales > 0);
    const peak = [...open].sort((a, b) => b.sales - a.sales)[0];
    const quiet = open.filter((b) => b.hour24 >= 9 && b.hour24 <= 17).sort((a, b) => a.sales - b.sales).slice(0, 2).sort((a, b) => a.hour24 - b.hour24);
    out.push(`Lunch (noon–3 pm) brings ${ins.hourly.lunchShare}% of sales${peak ? `; the busiest hour is ${hourName(peak.hour24)}` : ""}.`);
    if (quiet.length) out.push(`Quietest daytime hours: ${quiet.map((b) => hourName(b.hour24)).join(" and ")}, good for preparing catering orders.`);
  }
  if (ins.days) out.push(`Busiest day ${ins.days.busiest.day}; weekdays average ${money(ins.days.weekdayAvg)} a day, weekends ${money(ins.days.weekendAvg)}.`);
  if (ins.drinkPct != null) out.push(`${ins.drinkPct}% of orders include a drink.`);
  if (ins.discountPctOfSales != null) out.push(`Discounts already give away ${ins.discountPctOfSales}% of sales, so new deals should be targeted.`);
  if (ins.bread?.weekendSurplus) out.push(`Extra bread left over at weekends (${ins.bread.weekendSurplus} pieces).`);
  out.push(`Catering: from ${restaurant.minCateringOrder} people, delivered within ${restaurant.radiusMiles} mi${restaurant.openingHours ? `; open ${restaurant.openingHours}` : ""}.`);
  return out;
}

const keyFor = (restaurantId: string, day: string) => `daily:${restaurantId}:${day}`;

/** What the context is built from; a change rebuilds it the same day. */
async function sourcesHash(restaurant: Restaurant) {
  const [reports, scan] = await Promise.all([
    db.reportUpload.findMany({ where: { restaurantId: restaurant.id, status: { not: "FLAGGED" } }, select: { id: true, status: true } }),
    db.leadScan.findFirst({ where: { restaurantId: restaurant.id, status: "DONE" }, orderBy: { createdAt: "desc" }, select: { id: true } }),
  ]);
  const rules = [restaurant.minCateringOrder, restaurant.radiusMiles, restaurant.openingHours, restaurant.allowFreeExtra, restaurant.allowFreeDelivery, restaurant.maxDiscountPct];
  const leadsChanged = await db.lead.aggregate({ where: { restaurantId: restaurant.id }, _max: { updatedAt: true }, _count: true });
  return createHash("sha256")
    .update(JSON.stringify({ reports, scan: scan?.id, rules, leads: [leadsChanged._count, leadsChanged._max.updatedAt] }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Today's context: from the cache when nothing changed, else built from the
 * database (no API calls, no AI) and cached until midnight Pacific.
 */
export async function dailyContext(restaurantId: string, now = new Date()): Promise<DailyContext | null> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return null;
  const day = pacificDay(now);
  const key = keyFor(restaurantId, day);
  const hash = await sourcesHash(restaurant);
  const hit = await db.cacheEntry.findUnique({ where: { key } });
  const stored = hit?.value as unknown as DailyContext | undefined;
  if (stored && stored.hash === hash && hit!.expiresAt > now) return stored;

  // Imported here: the leads module imports this one.
  const { toEventInfo, toLeadInfo } = await import("@/lib/leads");
  const [reports, leads, events] = await Promise.all([
    db.reportUpload.findMany({ where: { restaurantId, status: { not: "FLAGGED" } } }),
    db.lead.findMany({ where: { restaurantId, status: { in: ["NEW", "DRAFTED"] } }, include: { contacts: true }, orderBy: { fitScore: "desc" }, take: DAILY_LIMITS.leads }),
    db.event.findMany({ where: { restaurantId, startsAt: { gte: now, lte: new Date(now.getTime() + 30 * 86_400_000) } }, orderBy: { fitScore: "desc" }, take: DAILY_LIMITS.events }),
  ]);
  const ctx: DailyContext = {
    day,
    hash,
    builtAt: now.toISOString(),
    brief: reports.length ? storeBrief(computeInsights(reports.map((r) => r.data as unknown as ParsedReport)), restaurant) : [],
    leads: leads.map(toLeadInfo),
    events: events.map((e) => toEventInfo(e, now)),
  };
  const value = JSON.parse(JSON.stringify(ctx));
  const expiresAt = nextPacificMidnight(now);
  await db.cacheEntry.upsert({ where: { key }, create: { key, value, expiresAt }, update: { value, expiresAt } });
  return ctx;
}

/** Forget today's context, e.g. after new reports, so the next step rebuilds it. */
export async function clearDailyContext(restaurantId: string, now = new Date()) {
  await db.cacheEntry.deleteMany({ where: { key: keyFor(restaurantId, pacificDay(now)) } });
}

/**
 * One DAILY job: build (or reuse) today's context, then ask the AI for the
 * customer deals and the top catering picks at the same time. Each part is
 * reused while its data is unchanged, so a retry only redoes what failed.
 */
export async function runDailyPlan(restaurantId: string, now = new Date()): Promise<string> {
  // The picks need the area scan; when it finishes it starts this job again.
  const scanning = await db.draftJob.findFirst({ where: { restaurantId, kind: "LEADS", status: { in: ["QUEUED", "RUNNING"] } } });
  if (scanning) return "Waiting for the area scan; the plan runs when it's done.";

  const { progress, buildDraftsFor } = await import("@/lib/drafts");
  const { suggestLeads } = await import("@/lib/leads");
  await progress(restaurantId, "DAILY", "Reading your reports and the area scan…");
  const ctx = await dailyContext(restaurantId, now);
  if (!ctx) return "Restaurant not found.";
  await progress(restaurantId, "DAILY", `Suggesting deals and picking the best of ${ctx.leads.length} businesses and ${ctx.events.length} events…`);
  const [deals, picks] = await Promise.allSettled([buildDraftsFor(restaurantId), ctx.leads.length ? suggestLeads(restaurantId, now) : Promise.resolve("No businesses yet: scan your area.")]);

  // A bad key stops everything; a busy AI makes the job try again later (finished parts are kept).
  const failures = [deals, picks].flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  const fatal = failures.find((e) => e instanceof AiConfigError);
  if (fatal) throw fatal;
  if (failures.length) throw failures[0];
  return `Deals: ${(deals as PromiseFulfilledResult<string>).value} Catering picks: ${(picks as PromiseFulfilledResult<string>).value}`;
}

/**
 * Starts today's plan the first time the owner opens the app on a new day:
 * an area scan (Google results are cached, events refresh) and then the plan.
 */
export async function ensureTodaysPlan(restaurantId: string, now = new Date()) {
  const startOfDay = new Date(nextPacificMidnight(now).getTime() - 86_400_000);
  const today = await db.draftJob.findFirst({ where: { restaurantId, kind: { in: ["DAILY", "LEADS"] }, createdAt: { gte: startOfDay } } });
  if (today) return false;
  const { enqueueDraftJob } = await import("@/lib/drafts");
  await enqueueDraftJob(restaurantId, "LEADS");
  return true;
}
