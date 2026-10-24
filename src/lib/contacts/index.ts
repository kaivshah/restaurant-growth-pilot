import { ProviderError } from "@/lib/llm";
import { parseRetryAfter, withRetry } from "@/lib/llm/retry";

export interface FoundContact {
  name: string | null;
  role: string | null;
  email: string;
  confidence: number | null;
}

export interface ContactsProvider {
  name: string;
  /** People at a company by its website domain, best first */
  findByDomain(domain: string): Promise<FoundContact[]>;
  /** "valid" | "accept_all" | "invalid" | "unknown" … */
  verify(email: string): Promise<string | null>;
}

/** Thrown when the monthly lookup quota is used up, so a scan stops instead of hammering the API. */
export class QuotaError extends Error {}

/** Roles that usually order team food, best first. */
const ROLE_PRIORITY = [/office manager/i, /executive assistant|ea\b/i, /admin/i, /operations|ops\b/i, /\bhr\b|human resources|people/i, /facilit/i, /event/i, /community/i, /manager/i];

export function rankContacts(list: FoundContact[]): FoundContact[] {
  const rank = (c: FoundContact) => {
    const i = ROLE_PRIORITY.findIndex((r) => r.test(c.role ?? ""));
    return (i < 0 ? ROLE_PRIORITY.length : i) * 1000 - (c.confidence ?? 0);
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

// ---------- Hunter.io ----------

type HunterEmail = { value: string; type?: string; confidence?: number; first_name?: string | null; last_name?: string | null; position?: string | null };

export function fromHunterDomainSearch(json: unknown): FoundContact[] {
  const emails = ((json as { data?: { emails?: HunterEmail[] } }).data?.emails ?? []) as HunterEmail[];
  return emails
    .filter((e) => e.value)
    .map((e) => ({
      name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      role: e.position ?? null,
      email: e.value.toLowerCase(),
      confidence: e.confidence ?? null,
    }));
}

async function hunterGet(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  const body = (await res.json().catch(() => ({}))) as { errors?: { id?: string; details?: string }[] };
  if (res.ok) return body;
  const err = body.errors?.[0];
  if (res.status === 429 && !/usage|quota|limit/i.test(`${err?.id} ${err?.details}`)) {
    throw new ProviderError("Hunter rate limit reached", true, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (res.status === 429 || res.status === 403 || /usage|quota/i.test(`${err?.id} ${err?.details}`)) {
    throw new QuotaError(`Hunter lookup limit reached: ${err?.details ?? res.status}`);
  }
  if (res.status >= 500) throw new ProviderError(`Hunter returned ${res.status}`, true);
  throw new ProviderError(`Hunter returned ${res.status}: ${err?.details ?? ""}`, false);
}

export function hunter(apiKey: string): ContactsProvider {
  return {
    name: "hunter",
    async findByDomain(domain) {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&type=personal&api_key=${apiKey}`;
      const { value } = await withRetry((signal) => hunterGet(url, signal), { retries: 2 });
      return rankContacts(fromHunterDomainSearch(value));
    },
    async verify(email) {
      const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${apiKey}`;
      const { value } = await withRetry((signal) => hunterGet(url, signal), { retries: 2, timeoutMs: 45_000 });
      return ((value as { data?: { status?: string } }).data?.status ?? null) as string | null;
    },
  };
}

// ---------- Fake ----------

const FAKE_PEOPLE: Record<string, FoundContact[]> = {
  "northwind.example": [
    { name: "Jordan Lee", role: "Office Manager", email: "jordan.l@northwind.example", confidence: 94 },
    { name: "Priya Shah", role: "Software Engineer", email: "priya@northwind.example", confidence: 90 },
  ],
  "canyonworks.example": [{ name: "Sam Patel", role: "Community Manager", email: "sam@canyonworks.example", confidence: 88 }],
  "mesaridgedental.example": [{ name: "Ana Ruiz", role: "Practice Manager", email: "ana.ruiz@mesaridgedental.example", confidence: 82 }],
  "torreyfreight.example": [{ name: "Chris Nguyen", role: "HR Coordinator", email: "c.nguyen@torreyfreight.example", confidence: 77 }],
  "bmeventhall.example": [{ name: "Riley Brooks", role: "Events Coordinator", email: "events@bmeventhall.example", confidence: 85 }],
};

export function fakeContacts(): ContactsProvider {
  return {
    name: "fake",
    async findByDomain(domain) {
      return rankContacts(FAKE_PEOPLE[domain] ?? []);
    },
    async verify(email) {
      return email.startsWith("events@") ? "accept_all" : "valid";
    },
  };
}

export function contactsFromEnv(env: NodeJS.ProcessEnv = process.env): ContactsProvider | null {
  const choice = (env.CONTACTS_PROVIDER ?? "off").toLowerCase();
  if (choice === "hunter") {
    if (!env.HUNTER_API_KEY) {
      console.warn("CONTACTS_PROVIDER=hunter but HUNTER_API_KEY is not set; contact lookup is off.");
      return null;
    }
    return hunter(env.HUNTER_API_KEY);
  }
  if (choice === "fake" && env.NODE_ENV !== "production") return fakeContacts();
  return null;
}
