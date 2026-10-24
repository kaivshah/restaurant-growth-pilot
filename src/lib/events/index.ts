import { ProviderError } from "@/lib/llm";
import { parseRetryAfter, withRetry } from "@/lib/llm/retry";
import type { LatLng } from "@/lib/geo";

export type EventCategory = "conference" | "expo" | "corporate" | "sports" | "community" | "concert" | "school" | "other";

export interface LocalEvent {
  source: string;
  externalId: string;
  title: string;
  category: EventCategory;
  startsAt: Date;
  endsAt: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  location: LatLng | null;
  attendance: number | null;
  organizer: string | null;
  url: string | null;
  description?: string | null;
}

export interface EventsProvider {
  name: string;
  upcoming(center: LatLng, radiusMiles: number, from: Date, to: Date): Promise<LocalEvent[]>;
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal, who: string) {
  const res = await fetch(url, { headers, signal });
  if (res.status === 429 || res.status >= 500) {
    throw new ProviderError(`${who} returned ${res.status}`, true, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (!res.ok) throw new ProviderError(`${who} returned ${res.status}: ${(await res.text()).slice(0, 200)}`, false);
  return res.json();
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ---------- PredictHQ ----------

const PHQ_CATEGORY: Record<string, EventCategory> = {
  conferences: "conference",
  expos: "expo",
  sports: "sports",
  community: "community",
  concerts: "concert",
  festivals: "community",
  "performing-arts": "concert",
  "school-holidays": "school",
};

type PhqEvent = {
  id: string;
  title: string;
  category: string;
  start?: string;
  end?: string;
  phq_attendance?: number | null;
  location?: [number, number];
  geo?: { geometry?: { coordinates?: [number, number] } };
  entities?: { type?: string; name?: string; formatted_address?: string }[];
};

export function fromPredictHq(json: unknown): LocalEvent[] {
  const results = ((json as { results?: PhqEvent[] }).results ?? []) as PhqEvent[];
  return results
    .filter((e) => e.id && e.title && e.start)
    .map((e) => {
      const coords = e.geo?.geometry?.coordinates ?? e.location;
      const venue = e.entities?.find((x) => x.type === "venue");
      const organizer = e.entities?.find((x) => x.type === "organization" || x.type === "organizer");
      return {
        source: "predicthq",
        externalId: e.id,
        title: e.title,
        category: PHQ_CATEGORY[e.category] ?? "other",
        startsAt: new Date(e.start!),
        endsAt: e.end ? new Date(e.end) : null,
        venueName: venue?.name ?? null,
        venueAddress: venue?.formatted_address ?? null,
        location: coords ? { lat: coords[1], lng: coords[0] } : null,
        attendance: e.phq_attendance ?? null,
        organizer: organizer?.name ?? null,
        url: null,
      };
    });
}

/**
 * PredictHQ Events API. On the free plan, searches must use a saved location
 * (PREDICTHQ_LOCATION_ID); otherwise we search within the radius.
 */
export function predictHq(token: string, savedLocationId?: string): EventsProvider {
  return {
    name: "predicthq",
    async upcoming(center, radiusMiles, from, to) {
      const params = new URLSearchParams({
        "active.gte": ymd(from),
        "active.lte": ymd(to),
        category: "conferences,expos,community,sports,festivals,concerts,performing-arts",
        sort: "-phq_attendance",
        limit: "50",
      });
      if (savedLocationId) params.set("saved_location.location_id", savedLocationId);
      else params.set("within", `${radiusMiles}mi@${center.lat},${center.lng}`);
      const { value } = await withRetry((signal) =>
        getJson(`https://api.predicthq.com/v1/events/?${params}`, { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal, "PredictHQ"),
      );
      return fromPredictHq(value);
    },
  };
}

// ---------- Ticketmaster Discovery ----------

type TmEvent = {
  id: string;
  name: string;
  url?: string;
  dates?: { start?: { dateTime?: string; localDate?: string } };
  classifications?: { segment?: { name?: string } }[];
  _embedded?: { venues?: { name?: string; address?: { line1?: string }; city?: { name?: string }; location?: { latitude?: string; longitude?: string } }[] };
};

export function fromTicketmaster(json: unknown): LocalEvent[] {
  const events = ((json as { _embedded?: { events?: TmEvent[] } })._embedded?.events ?? []) as TmEvent[];
  return events
    .filter((e) => e.id && e.name && (e.dates?.start?.dateTime || e.dates?.start?.localDate))
    .map((e) => {
      const v = e._embedded?.venues?.[0];
      const segment = e.classifications?.[0]?.segment?.name?.toLowerCase() ?? "";
      const lat = Number(v?.location?.latitude);
      const lng = Number(v?.location?.longitude);
      return {
        source: "ticketmaster",
        externalId: e.id,
        title: e.name,
        category: segment === "sports" ? "sports" : segment === "music" || segment === "arts & theatre" ? "concert" : "other",
        startsAt: new Date(e.dates!.start!.dateTime ?? `${e.dates!.start!.localDate}T12:00:00`),
        endsAt: null,
        venueName: v?.name ?? null,
        venueAddress: [v?.address?.line1, v?.city?.name].filter(Boolean).join(", ") || null,
        location: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
        attendance: null,
        organizer: null,
        url: e.url ?? null,
      };
    });
}

export function ticketmaster(apiKey: string): EventsProvider {
  return {
    name: "ticketmaster",
    async upcoming(center, radiusMiles, from, to) {
      const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
      const params = new URLSearchParams({
        apikey: apiKey,
        latlong: `${center.lat},${center.lng}`,
        radius: String(Math.max(1, Math.round(radiusMiles))),
        unit: "miles",
        startDateTime: iso(from),
        endDateTime: iso(to),
        size: "50",
        sort: "date,asc",
      });
      const { value } = await withRetry((signal) => getJson(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, {}, signal, "Ticketmaster"));
      return fromTicketmaster(value);
    },
  };
}

// ---------- Fake ----------

export function fakeEvents(): EventsProvider {
  return {
    name: "fake",
    async upcoming(center, _radius, from) {
      const at = (days: number) => new Date(from.getTime() + days * 86_400_000);
      const near = (dLat: number, dLng: number) => ({ lat: center.lat + dLat, lng: center.lng + dLng });
      return [
        { source: "fake", externalId: "fake-biotech-summit", title: "[Sample] North County Biotech Summit", category: "conference", startsAt: at(21), endsAt: at(22), venueName: "Black Mountain Event Hall", venueAddress: "[Sample] 7 Park Village Rd, San Diego, CA", location: near(-0.015, 0.025), attendance: 1200, organizer: null, url: null },
        { source: "fake", externalId: "fake-youth-soccer", title: "[Sample] Spring Youth Soccer Tournament", category: "sports", startsAt: at(35), endsAt: at(36), venueName: "Hilltop Sports Park", venueAddress: "[Sample] 10 Park Rd, San Diego, CA", location: near(0.01, 0.01), attendance: 600, organizer: null, url: null },
        { source: "fake", externalId: "fake-concert", title: "[Sample] Summer Concert in the Park", category: "concert", startsAt: at(10), endsAt: null, venueName: null, venueAddress: null, location: near(0.005, 0.005), attendance: 300, organizer: null, url: null },
        { source: "fake", externalId: "fake-too-soon", title: "[Sample] Farmers Market", category: "community", startsAt: at(2), endsAt: null, venueName: null, venueAddress: null, location: near(0.002, 0.002), attendance: 400, organizer: null, url: null },
      ];
    },
  };
}

/** Every events source turned on in the environment. EVENTS_PROVIDER=fake for local testing. */
export function eventsFromEnv(env: NodeJS.ProcessEnv = process.env): EventsProvider[] {
  if ((env.EVENTS_PROVIDER ?? "").toLowerCase() === "fake" && env.NODE_ENV !== "production") return [fakeEvents()];
  const out: EventsProvider[] = [];
  if (env.PREDICTHQ_API_KEY) out.push(predictHq(env.PREDICTHQ_API_KEY, env.PREDICTHQ_LOCATION_ID || undefined));
  if (env.TICKETMASTER_API_KEY) out.push(ticketmaster(env.TICKETMASTER_API_KEY));
  return out;
}
