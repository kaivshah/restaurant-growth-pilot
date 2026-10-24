export interface LatLng {
  lat: number;
  lng: number;
}

/** Straight-line distance in miles. */
export function milesBetween(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** A box around a point, for APIs that restrict searches to a rectangle. */
export function boundingBox(center: LatLng, miles: number) {
  const dLat = miles / 69;
  const dLng = miles / (69 * Math.cos((center.lat * Math.PI) / 180));
  return { low: { lat: center.lat - dLat, lng: center.lng - dLng }, high: { lat: center.lat + dLat, lng: center.lng + dLng } };
}

/** "https://www.northwind.com/about" → "northwind.com" */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Domains that are platforms, not the business itself, so they don't help find a contact. */
const PLATFORM_DOMAINS = ["facebook.com", "instagram.com", "linkedin.com", "yelp.com", "google.com", "sites.google.com", "wixsite.com", "squarespace.com", "linktr.ee"];

export function isUsefulDomain(domain: string | null): domain is string {
  return Boolean(domain) && !PLATFORM_DOMAINS.some((p) => domain === p || domain!.endsWith(`.${p}`));
}
