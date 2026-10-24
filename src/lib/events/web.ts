import { createHash } from "node:crypto";
import { z } from "zod";
import { LATEST_FLASH, geminiGenerate, replyText } from "@/lib/llm/gemini";
import { withRetry } from "@/lib/llm/retry";
import type { EventCategory, LocalEvent } from "./index";

/**
 * Finds upcoming events on the open web: Gemini with Google Search grounding
 * looks for conferences, expos, corporate events at nearby companies,
 * tournaments and community events, and returns them as a list. Each event
 * keeps a link to the page it came from so the owner can check it.
 */

export interface WebEventsQuery {
  address: string;
  radiusMiles: number;
  from: Date;
  to: Date;
  /** Nearby companies to look for corporate events at */
  companies: string[];
}

export interface WebEventsProvider {
  name: string;
  find(q: WebEventsQuery): Promise<LocalEvent[]>;
}

const CATEGORIES = ["conference", "expo", "corporate", "community", "sports", "school", "concert", "other"] as const;

const WebEvent = z.object({
  title: z.string().min(3).max(200),
  date: z.string(),
  end_date: z.string().nullish(),
  category: z.string().nullish(),
  venue: z.string().max(200).nullish(),
  address: z.string().max(300).nullish(),
  organizer: z.string().max(200).nullish(),
  expected_attendance: z.coerce.number().int().positive().max(1_000_000).nullish().catch(null),
  description: z.string().max(600).nullish(),
  url: z.string().max(1000).nullish(),
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function webEventsPrompt(q: WebEventsQuery) {
  const companies = q.companies.length ? `\n- corporate events, conferences, open days or large meetings hosted by or at these nearby companies: ${q.companies.slice(0, 20).join("; ")}` : "";
  return `Search the web for events between ${ymd(q.from)} and ${ymd(q.to)} within about ${q.radiusMiles} miles of ${q.address} where a local restaurant could cater food for staff, exhibitors, teams or attendees. Look for:
- conferences, trade shows, expos and business networking events${companies}
- school events, youth and adult sports tournaments
- community festivals, fundraisers, charity runs and large meetings at hotels or event venues

Only include events with a specific date in that range that you found on a real web page. Don't guess dates or numbers.
Reply with only a JSON array (no other text), at most 25 items, each:
{"title": string, "date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" or null, "category": one of ${CATEGORIES.join("|")}, "venue": string or null, "address": street address or null, "organizer": string or null, "expected_attendance": number or null (only if the page states it), "description": one sentence, "url": the page you found it on}`;
}

/** Reads the model's reply into events, dropping anything without a valid date in the window. */
export function parseWebEvents(text: string, from: Date, to: Date, sources: string[] = []): LocalEvent[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LocalEvent[] = [];
  for (const item of raw) {
    const parsed = WebEvent.safeParse(item);
    if (!parsed.success) continue;
    const e = parsed.data;
    const startsAt = new Date(`${e.date.slice(0, 10)}T12:00:00`);
    if (Number.isNaN(startsAt.getTime()) || startsAt < from || startsAt > to) continue;
    const key = `${e.title.toLowerCase().replace(/\W+/g, " ").trim()}|${ymd(startsAt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const endsAt = e.end_date ? new Date(`${e.end_date.slice(0, 10)}T12:00:00`) : null;
    const category = (CATEGORIES as readonly string[]).includes(e.category ?? "") ? (e.category as EventCategory) : "other";
    out.push({
      source: "web",
      externalId: createHash("sha1").update(key).digest("hex").slice(0, 16),
      title: e.title.trim(),
      category,
      startsAt,
      endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
      venueName: e.venue?.trim() || null,
      venueAddress: e.address?.trim() || null,
      location: null,
      attendance: e.expected_attendance ?? null,
      organizer: e.organizer?.trim() || null,
      url: e.url?.startsWith("http") ? e.url : (sources[0] ?? null),
      description: e.description?.trim() || null,
    });
  }
  return out;
}

export function geminiWebEvents(apiKey: string, model: string): WebEventsProvider {
  return {
    name: "web",
    async find(q) {
      const { value } = await withRetry(
        (signal) =>
          geminiGenerate(apiKey, model, { contents: [{ role: "user", parts: [{ text: webEventsPrompt(q) }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }, signal),
        { timeoutMs: 120_000, retries: 1 },
      );
      const sources = (value.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).flatMap((c) => (c.web?.uri ? [c.web.uri] : []));
      return parseWebEvents(replyText(value), q.from, q.to, sources);
    },
  };
}

/** Sample web events for EVENTS_PROVIDER=fake. */
export function fakeWebEvents(): WebEventsProvider {
  return {
    name: "web",
    async find(q) {
      const at = (days: number) => new Date(q.from.getTime() + days * 86_400_000);
      const company = q.companies[0] ?? "Northwind Analytics";
      return [
        { source: "web", externalId: "fake-web-allhands", title: `[Sample] ${company} quarterly all-hands`, category: "corporate", startsAt: at(18), endsAt: null, venueName: company, venueAddress: null, location: null, attendance: 150, organizer: company, url: "https://example.com/allhands", description: "Company-wide meeting with lunch for staff." },
        { source: "web", externalId: "fake-web-expo", title: "[Sample] North County Small Business Expo", category: "expo", startsAt: at(28), endsAt: at(29), venueName: "Black Mountain Event Hall", venueAddress: "[Sample] 7 Park Village Rd, San Diego, CA", location: null, attendance: null, organizer: "North County Chamber", url: "https://example.com/expo", description: "Local business expo with about 80 exhibitor booths." },
      ];
    },
  };
}

/**
 * Web event search: on with a Gemini key (WEB_EVENTS="off" turns it off),
 * sample events when EVENTS_PROVIDER=fake.
 */
export function webEventsFromEnv(env: NodeJS.ProcessEnv = process.env): WebEventsProvider | null {
  const choice = (env.WEB_EVENTS ?? "").toLowerCase();
  if (choice === "off") return null;
  if ((env.EVENTS_PROVIDER ?? "").toLowerCase() === "fake" && env.NODE_ENV !== "production") return fakeWebEvents();
  if (!env.GEMINI_API_KEY) return null;
  return geminiWebEvents(env.GEMINI_API_KEY, env.GEMINI_MODEL || LATEST_FLASH);
}
