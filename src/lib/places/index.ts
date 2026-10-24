import { ProviderError } from "@/lib/llm";
import { parseRetryAfter, withRetry } from "@/lib/llm/retry";
import { DAY, cacheKey, cached } from "@/lib/cache";
import { type LatLng, boundingBox } from "@/lib/geo";

export type LeadCategory = "office" | "coworking" | "school" | "clinic" | "gym" | "venue" | "other";

export interface Place {
  placeId: string;
  name: string;
  category: LeadCategory;
  types: string[];
  address: string;
  location: LatLng;
  website: string | null;
  phone: string | null;
  ratingCount: number | null;
  businessStatus: string | null;
}

export interface PlacesProvider {
  name: string;
  geocode(address: string): Promise<LatLng | null>;
  /** Businesses of one category around a point */
  search(category: LeadCategory, center: LatLng, radiusMiles: number): Promise<Place[]>;
  /** One place by name near a point, e.g. an event's venue */
  findByName?(name: string, center: LatLng): Promise<Place | null>;
}

export const SEARCHES: { category: LeadCategory; query: string }[] = [
  { category: "office", query: "corporate office" },
  { category: "coworking", query: "coworking space" },
  { category: "school", query: "school" },
  { category: "clinic", query: "medical clinic" },
  { category: "gym", query: "gym" },
  { category: "venue", query: "event venue" },
];

// ---------- Google: Geocoding API + Places API (New) Text Search ----------

const FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.businessStatus",
  "places.userRatingCount",
].join(",");

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
  businessStatus?: string;
  userRatingCount?: number;
};

export function fromGooglePlace(p: GooglePlace, category: LeadCategory): Place | null {
  if (!p.id || !p.location || !p.displayName?.text) return null;
  return {
    placeId: p.id,
    name: p.displayName.text,
    category,
    types: p.types ?? [],
    address: p.formattedAddress ?? "",
    location: { lat: p.location.latitude, lng: p.location.longitude },
    website: p.websiteUri ?? null,
    phone: p.nationalPhoneNumber ?? null,
    ratingCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
  };
}

async function googleFetch(url: string, init: RequestInit, signal: AbortSignal) {
  const res = await fetch(url, { ...init, signal });
  if (res.status === 429 || res.status >= 500) {
    throw new ProviderError(`Google returned ${res.status}`, true, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (!res.ok) throw new ProviderError(`Google returned ${res.status}: ${(await res.text()).slice(0, 200)}`, false);
  return res.json();
}

export function googlePlaces(apiKey: string): PlacesProvider {
  const searchText = async (body: Record<string, unknown>) => {
    const { value } = await withRetry((signal) =>
      googleFetch(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELDS },
          body: JSON.stringify(body),
        },
        signal,
      ),
    );
    return ((value as { places?: GooglePlace[] }).places ?? []) as GooglePlace[];
  };

  return {
    name: "google",
    async geocode(address) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
      const { value } = await withRetry((signal) => googleFetch(url, {}, signal));
      const data = value as { status: string; results?: { geometry: { location: { lat: number; lng: number } } }[]; error_message?: string };
      if (data.status === "ZERO_RESULTS") return null;
      if (data.status !== "OK") throw new ProviderError(`Geocoding failed: ${data.status}${data.error_message ? ` (${data.error_message})` : ""}`, false);
      return data.results?.[0]?.geometry.location ?? null;
    },
    async search(category, center, radiusMiles) {
      const q = SEARCHES.find((s) => s.category === category)?.query ?? category;
      const box = boundingBox(center, radiusMiles);
      const places = await searchText({
        textQuery: q,
        pageSize: 20,
        locationRestriction: {
          rectangle: {
            low: { latitude: box.low.lat, longitude: box.low.lng },
            high: { latitude: box.high.lat, longitude: box.high.lng },
          },
        },
      });
      return places.map((p) => fromGooglePlace(p, category)).filter((p): p is Place => p !== null);
    },
    async findByName(name, center) {
      const places = await searchText({
        textQuery: name,
        pageSize: 1,
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 10_000 } },
      });
      return places.length ? fromGooglePlace(places[0], "venue") : null;
    },
  };
}

// ---------- Fake: made-up San Diego businesses for tests and keyless runs ----------

const ORIGIN: LatLng = { lat: 32.9595, lng: -117.145 };

const FAKE: (Omit<Place, "location"> & { offset: [number, number] })[] = [
  { placeId: "fake-northwind", name: "Northwind Analytics", category: "office", types: ["corporate_office"], address: "[Sample] 1 Sorrento Valley Rd, San Diego, CA", website: "https://northwind.example", phone: null, ratingCount: 140, businessStatus: "OPERATIONAL", offset: [0.012, 0.008] },
  { placeId: "fake-torrey", name: "Torrey Freight Logistics", category: "office", types: ["corporate_office"], address: "[Sample] 2 Miramar Rd, San Diego, CA", website: "https://torreyfreight.example", phone: null, ratingCount: 60, businessStatus: "OPERATIONAL", offset: [-0.03, 0.02] },
  { placeId: "fake-canyonworks", name: "Canyon Works Coworking", category: "coworking", types: ["coworking_space"], address: "[Sample] 3 Carmel Mountain Rd, San Diego, CA", website: "https://canyonworks.example", phone: null, ratingCount: 210, businessStatus: "OPERATIONAL", offset: [0.02, -0.015] },
  { placeId: "fake-pcelementary", name: "Peñasquitos Creek Elementary", category: "school", types: ["primary_school"], address: "[Sample] 4 Black Mountain Rd, San Diego, CA", website: "https://pcelementary.example", phone: null, ratingCount: 35, businessStatus: "OPERATIONAL", offset: [-0.008, -0.006] },
  { placeId: "fake-mesaridge", name: "Mesa Ridge Dental Group", category: "clinic", types: ["dentist"], address: "[Sample] 5 Rancho Peñasquitos Blvd, San Diego, CA", website: "https://mesaridgedental.example", phone: null, ratingCount: 95, businessStatus: "OPERATIONAL", offset: [0.004, 0.006] },
  { placeId: "fake-summitfit", name: "Summit Fitness Club", category: "gym", types: ["gym"], address: "[Sample] 6 Twin Peaks Rd, San Diego, CA", website: "https://www.facebook.com/summitfit", phone: null, ratingCount: 400, businessStatus: "OPERATIONAL", offset: [0.025, 0.03] },
  { placeId: "fake-hall", name: "Black Mountain Event Hall", category: "venue", types: ["event_venue"], address: "[Sample] 7 Park Village Rd, San Diego, CA", website: "https://bmeventhall.example", phone: null, ratingCount: 80, businessStatus: "OPERATIONAL", offset: [-0.015, 0.025] },
  { placeId: "fake-closed", name: "Old Mill Offices", category: "office", types: ["corporate_office"], address: "[Sample] 8 Old Rd, San Diego, CA", website: null, phone: null, ratingCount: 3, businessStatus: "CLOSED_PERMANENTLY", offset: [0.01, -0.02] },
  { placeId: "fake-far", name: "Faraway Tech Campus", category: "office", types: ["corporate_office"], address: "[Sample] 9 Far Rd, San Diego, CA", website: "https://faraway.example", phone: null, ratingCount: 500, businessStatus: "OPERATIONAL", offset: [0.2, 0.2] },
];

export function fakePlaces(): PlacesProvider {
  const all = FAKE.map(({ offset, ...p }) => ({ ...p, location: { lat: ORIGIN.lat + offset[0], lng: ORIGIN.lng + offset[1] } }));
  return {
    name: "fake",
    async geocode() {
      return ORIGIN;
    },
    async search(category) {
      return all.filter((p) => p.category === category);
    },
    async findByName(name) {
      return all.find((p) => p.name.toLowerCase().includes(name.toLowerCase().split(" ")[0])) ?? null;
    },
  };
}

/**
 * Google results shared across restaurants and processes. Places content is
 * kept 7 days (Google allows up to 30); a nearby franchisee scanning the same
 * area reuses it. Points are rounded to about 100 m so tiny address
 * differences still hit the cache.
 */
export function cachedPlaces(inner: PlacesProvider): PlacesProvider {
  const at = (p: LatLng, digits = 3) => [p.lat.toFixed(digits), p.lng.toFixed(digits)];
  return {
    name: inner.name,
    geocode: (address) => cached(cacheKey("geocode", inner.name, address.trim().toLowerCase()), 30 * DAY, () => inner.geocode(address)),
    search: (category, center, radiusMiles) => cached(cacheKey("places", inner.name, category, at(center), radiusMiles), 7 * DAY, () => inner.search(category, center, radiusMiles)),
    findByName: inner.findByName
      ? (name, center) => cached(cacheKey("place-name", inner.name, name.trim().toLowerCase(), at(center, 2)), 7 * DAY, () => inner.findByName!(name, center))
      : undefined,
  };
}

export function placesFromEnv(env: NodeJS.ProcessEnv = process.env): PlacesProvider | null {
  const choice = (env.PLACES_PROVIDER ?? "off").toLowerCase();
  if (choice === "google") {
    if (!env.GOOGLE_MAPS_API_KEY) {
      console.warn("PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set; area scan is off.");
      return null;
    }
    return cachedPlaces(googlePlaces(env.GOOGLE_MAPS_API_KEY));
  }
  if (choice === "fake" && env.NODE_ENV !== "production") return fakePlaces();
  return null;
}
