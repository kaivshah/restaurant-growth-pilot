import { createHash } from "node:crypto";
import { z } from "zod";
import { DAY, HOUR, cacheKey, cached } from "@/lib/cache";
import { LATEST_FLASH, geminiGenerate, replyText } from "@/lib/llm/gemini";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_DEFAULT_MODEL, claudeClient, claudeError, fallbackParams } from "@/lib/llm/claude";
import { withRetry } from "@/lib/llm/retry";
import { ProviderError } from "@/lib/llm/types";
import type { EventCategory, LocalEvent } from "./index";

/**
 * Finds upcoming events on the open web: Claude's web search (or Gemini with
 * Google Search) looks for conferences, expos, corporate events at nearby companies,
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

/** "100 Example Rd, San Diego, CA 92129" → the city and state, to point web searches at the right place. */
export function placeOf(address: string): { city: string | null; region: string | null } {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return { city: null, region: null };
  const state = parts[parts.length - 1].match(/^([A-Za-z]{2})\b/)?.[1] ?? null;
  return { city: parts[parts.length - 2] || null, region: state };
}

/** Most searches Claude may run for one event search (each search is billed). */
const MAX_SEARCHES = 5;
/** Server-side searches can pause a long turn; it's continued this many times at most. */
const MAX_CONTINUES = 3;

/**
 * The same search on Claude, with its web search tool. One request (plus a
 * continuation if the search pauses), at most five searches, located to the
 * store's city. Claude's reply is the same JSON list the Gemini search gives.
 */
export function claudeWebEvents(apiKey: string, model: string): WebEventsProvider {
  const client = claudeClient(apiKey);
  return {
    name: "web",
    async find(q) {
      const { city, region } = placeOf(q.address);
      const { value } = await withRetry(
        async (signal) => {
          const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: webEventsPrompt(q) }];
          const texts: string[] = [];
          const sources: string[] = [];
          try {
            for (let turn = 0; turn <= MAX_CONTINUES; turn++) {
              const response = await client.beta.messages.create(
                {
                  model,
                  max_tokens: 16000,
                  tools: [
                    {
                      type: "web_search_20260209",
                      name: "web_search",
                      max_uses: MAX_SEARCHES,
                      user_location: { type: "approximate", country: "US", timezone: "America/Los_Angeles", ...(city ? { city } : {}), ...(region ? { region } : {}) },
                    },
                  ],
                  messages,
                  // Listing what the searches found doesn't need deep thinking.
                  output_config: { effort: "low" },
                  ...fallbackParams(model),
                },
                { signal },
              );
              for (const block of response.content) {
                if (block.type === "text") texts.push(block.text);
                // A failed search comes back as an error object instead of a list of results.
                if (block.type === "web_search_tool_result" && Array.isArray(block.content)) sources.push(...block.content.map((r) => r.url));
              }
              if (response.stop_reason === "refusal") throw new ProviderError("Claude declined this web search", false);
              // A long search turn pauses; sending it back lets the server carry on where it stopped.
              if (response.stop_reason !== "pause_turn") break;
              messages.push({ role: "assistant", content: response.content });
            }
          } catch (err) {
            throw claudeError(err);
          }
          return { text: texts.join(""), sources };
        },
        { timeoutMs: 180_000, retries: 1 },
      );
      console.log(`[web events] Claude searched the web: ${value.sources.length} pages read`);
      return parseWebEvents(value.text, q.from, q.to, value.sources);
    },
  };
}

/**
 * One web search per area, date window and company list per day, shared by
 * every restaurant nearby. An empty answer is kept only 6 hours.
 */
export function cachedWebEvents(inner: WebEventsProvider): WebEventsProvider {
  return {
    name: inner.name,
    find: (q) =>
      cached(cacheKey("web-events", q.address.trim().toLowerCase(), q.radiusMiles, ymd(q.from), ymd(q.to), [...q.companies].sort()), DAY, () => inner.find(q), {
        ttlFor: (found) => (found.length ? DAY : 6 * HOUR),
      }),
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
 * Web event search: Claude's web search when ANTHROPIC_API_KEY is set,
 * otherwise Gemini with Google Search (WEB_EVENTS_PROVIDER picks one). Runs
 * only when the owner clicks "Search the web for events", or on every scan
 * with WEB_EVENTS="on"; WEB_EVENTS="off" hides it. Sample events when
 * EVENTS_PROVIDER=fake.
 */
export function webEventsFromEnv(env: NodeJS.ProcessEnv = process.env): WebEventsProvider | null {
  const choice = (env.WEB_EVENTS ?? "").toLowerCase();
  if (choice === "off") return null;
  if ((env.EVENTS_PROVIDER ?? "").toLowerCase() === "fake" && env.NODE_ENV !== "production") return fakeWebEvents();
  const provider = (env.WEB_EVENTS_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : "")).toLowerCase();
  if (provider === "anthropic" && env.ANTHROPIC_API_KEY) return cachedWebEvents(claudeWebEvents(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL));
  if (provider === "gemini" && env.GEMINI_API_KEY) return cachedWebEvents(geminiWebEvents(env.GEMINI_API_KEY, env.GEMINI_MODEL || LATEST_FLASH));
  return null;
}
