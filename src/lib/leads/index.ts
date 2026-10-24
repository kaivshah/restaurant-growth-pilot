import { createHash } from "node:crypto";
import type { Contact, Event as EventRow, Lead, Restaurant } from "@prisma/client";
import { analystFromEnv, buildContext, estimateCostUsd, runLeadAnalysis } from "@/lib/analyst";
import type { EventInfo, LeadContext, LeadInfo, LeadOutcome, Pitch } from "@/lib/analyst";
import { type ContactsProvider, QuotaError, contactsFromEnv } from "@/lib/contacts";
import { db } from "@/lib/db";
import { DAILY_DRAFT_CAP, type PitchTarget, draftsToday, json, logAnalysisCall, logCall, progress, usableReports } from "@/lib/drafts";
import { type LocalEvent, eventsFromEnv } from "@/lib/events";
import { type WebEventsProvider, webEventsFromEnv } from "@/lib/events/web";
import { type LatLng, domainOf, isUsefulDomain, milesBetween } from "@/lib/geo";
import { AiBusyError, AiConfigError, type CopyProvider, type FactsPacket, type PitchFacts, missingAiReason, providerFromEnv, writeManyCopy, writeOfferCopy } from "@/lib/llm";
import { INDEPENDENT_LINE } from "@/lib/llm/validate";
import { isBrandSafe } from "@/lib/offers";
import { type Place, type PlacesProvider, SEARCHES, placesFromEnv } from "@/lib/places";
import type { ParsedReport } from "@/lib/reports";
import { categoryLabel, scoreEvent, scoreLead } from "./score";

/** Google's terms: Place content is refreshed or removed after 30 days. */
const PLACE_TTL_MS = 30 * 86_400_000;
/** A rules change or setup re-run reuses a scan newer than this instead of searching again. */
const RESCAN_AFTER_MS = 24 * 3_600_000;
const CONTACTS_PER_LEAD = 3;

export const OFFER_TEXT: Record<Pitch["offer"], string> = {
  free_cookie_platter: "a free cookie platter",
  free_drinks_tray: "a free tray of drinks",
  free_delivery: "free delivery",
};

export function mapsUrl(placeId: string, name: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(placeId)}`;
}

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

type Counts = { leads: number; contacts: number; events: number; notes: string[] };

/** Provider error texts can be long; notes keep the first 160 characters. */
export const short = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * One LEADS job: find nearby businesses (Google Places) and upcoming events
 * (event APIs and a web search), score them, and save them for the owner to
 * browse. No AI picks and no pitches: the owner chooses what to pitch.
 * Returns a short summary for the job record.
 */
export async function scanArea(restaurantId: string, opts: { force?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId }, include: { outlets: true } });
  if (!restaurant) return "Restaurant not found.";
  const outlet = restaurant.outlets[0];
  if (!outlet) return "Add your store address first.";
  const places = placesFromEnv();
  const events = eventsFromEnv();
  const web = webEventsFromEnv();
  if (!places) return "Area scan is off. Set PLACES_PROVIDER=google (with GOOGLE_MAPS_API_KEY) or PLACES_PROVIDER=fake.";

  const lastScan = await db.leadScan.findFirst({ where: { restaurantId, status: "DONE" }, orderBy: { createdAt: "desc" } });
  const recent = lastScan && now.getTime() - lastScan.createdAt.getTime() < RESCAN_AFTER_MS && outlet.geocodedAddress === outlet.address;
  if (recent && !opts.force) return "Reused the scan from the last 24 hours.";
  const sources = [...events.map((e) => e.name), ...(web ? ["web search"] : [])];
  const scan = await db.leadScan.create({
    data: { restaurantId, placesProvider: places.name, contactsProvider: "on request", eventsProvider: sources.join(", ") || "off" },
  });

  const counts: Counts = { leads: 0, contacts: 0, events: 0, notes: [] };
  try {
    await progress(restaurantId, "LEADS", "Finding your store on the map…");
    const center = await locate(outlet, places);
    if (!center) throw new Error(`We couldn't find "${outlet.address}" on the map. Check the store address in setup.`);
    await progress(restaurantId, "LEADS", "Searching for offices, schools, clinics and venues nearby…");
    await findLeads(restaurant, center, places, now, counts);
    await progress(restaurantId, "LEADS", `Found ${counts.leads} businesses. Checking for upcoming events…`);
    await findEvents(restaurant, center, places, events, web, outlet.address, now, counts);
    const message = [`${counts.leads} businesses, ${counts.events} upcoming events`, ...counts.notes].join("; ");
    await db.leadScan.update({
      where: { id: scan.id },
      data: { status: "DONE", leadsFound: counts.leads, eventsFound: counts.events, message, finishedAt: new Date() },
    });
    return `${message}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.leadScan.update({
      where: { id: scan.id },
      data: { status: "FAILED", leadsFound: counts.leads, eventsFound: counts.events, message: short(message, 300), finishedAt: new Date() },
    });
    throw err;
  }
}

async function locate(outlet: { id: string; address: string; latitude: number | null; longitude: number | null; geocodedAddress: string | null }, places: PlacesProvider): Promise<LatLng | null> {
  if (outlet.latitude != null && outlet.longitude != null && outlet.geocodedAddress === outlet.address) {
    return { lat: outlet.latitude, lng: outlet.longitude };
  }
  const found = await places.geocode(outlet.address);
  if (!found) return null;
  await db.outlet.update({ where: { id: outlet.id }, data: { latitude: found.lat, longitude: found.lng, geocodedAddress: outlet.address } });
  return found;
}

/** Upserts a place as a lead, keeping the owner's decisions. Returns null when it doesn't qualify. */
async function saveLead(restaurant: Restaurant, center: LatLng, p: Place, source: string, now: Date): Promise<Lead | null> {
  const distanceMiles = milesBetween(center, p.location);
  const { score, reasons, excluded } = scoreLead(p, distanceMiles, restaurant.radiusMiles);
  if (excluded) return null;
  const data = {
    source,
    name: p.name,
    category: p.category,
    types: p.types,
    address: p.address,
    latitude: p.location.lat,
    longitude: p.location.lng,
    distanceMiles,
    website: p.website,
    phone: p.phone,
    ratingCount: p.ratingCount,
    businessStatus: p.businessStatus,
    fitScore: score,
    scoreReasons: reasons,
    fetchedAt: now,
  };
  return db.lead.upsert({
    where: { restaurantId_placeId: { restaurantId: restaurant.id, placeId: p.placeId } },
    create: { restaurantId: restaurant.id, placeId: p.placeId, ...data },
    update: data,
  });
}

async function findLeads(restaurant: Restaurant, center: LatLng, places: PlacesProvider, now: Date, counts: Counts) {
  const seen = new Map<string, Place>();
  for (const s of SEARCHES) {
    try {
      for (const p of await places.search(s.category, center, restaurant.radiusMiles)) if (!seen.has(p.placeId)) seen.set(p.placeId, p);
    } catch (err) {
      counts.notes.push(`${s.query} search failed (${short(err instanceof Error ? err.message : String(err))})`);
    }
  }
  if (seen.size === 0 && counts.notes.length === SEARCHES.length) throw new Error(`Every area search failed: ${counts.notes[0]}`);
  for (const p of seen.values()) if (await saveLead(restaurant, center, p, places.name, now)) counts.leads++;

  // Businesses from another source (e.g. sample data from testing) don't mix with this scan.
  const other = await db.lead.deleteMany({ where: { restaurantId: restaurant.id, source: { notIn: [places.name, "event"] }, status: { not: "APPROVED" } } });
  if (other.count) counts.notes.push(`removed ${other.count} businesses from an earlier ${places.name === "fake" ? "real" : "sample"} scan`);

  // Leads nobody acted on are removed once their Place data is too old to keep.
  const stale = await db.lead.deleteMany({ where: { restaurantId: restaurant.id, status: "NEW", fetchedAt: { lt: new Date(now.getTime() - PLACE_TTL_MS) } } });
  if (stale.count) counts.notes.push(`removed ${stale.count} businesses not seen for 30 days`);
}

/** One Hunter search (plus a check of the best email) for one business. Throws QuotaError when the plan is used up. */
export async function lookupContacts(leadId: string, domain: string, provider: ContactsProvider, now = new Date()): Promise<{ created: number; best: Contact | null }> {
  const people = (await provider.findByDomain(domain)).slice(0, CONTACTS_PER_LEAD);
  let created = 0;
  let best: Contact | null = null;
  for (const [i, c] of people.entries()) {
    const verification = i === 0 ? await provider.verify(c.email) : null;
    const existing = await db.contact.findUnique({ where: { leadId_email: { leadId, email: c.email } } });
    let row: Contact;
    if (existing) {
      row = existing.source === "owner" ? existing : await db.contact.update({ where: { id: existing.id }, data: { name: c.name, role: c.role, confidence: c.confidence, verification: verification ?? existing.verification } });
    } else {
      row = await db.contact.create({ data: { leadId, name: c.name, role: c.role, email: c.email, confidence: c.confidence, verification, source: provider.name } });
      created++;
    }
    if (i === 0) best = row;
  }
  await db.lead.update({ where: { id: leadId }, data: { contactsCheckedAt: now } });
  return { created, best };
}

const nameMatch = (a: string, b: string) => {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x));
};

/** Most Google lookups (venue search or address geocode) for web events per scan. */
const MAX_EVENT_LOOKUPS = 15;

async function findEvents(
  restaurant: Restaurant,
  center: LatLng,
  places: PlacesProvider,
  providers: ReturnType<typeof eventsFromEnv>,
  web: WebEventsProvider | null,
  address: string,
  now: Date,
  counts: Counts,
) {
  const active = [...providers.map((p) => p.name), ...(web ? [web.name] : [])];
  await db.event.deleteMany({ where: { restaurantId: restaurant.id, OR: [{ startsAt: { lt: now } }, { source: { notIn: active } }] } });
  if (active.length === 0) {
    counts.notes.push("event search is off");
    return;
  }
  const to = new Date(now.getTime() + 60 * 86_400_000);
  const leads = await db.lead.findMany({ where: { restaurantId: restaurant.id }, orderBy: { fitScore: "desc" } });
  let lookups = 0;

  const save = async (e: LocalEvent) => {
    // Who to pitch: the venue or the organiser, if it's a business we know or can find.
    let venue = leads.find((l) => (e.venueName && nameMatch(l.name, e.venueName)) || (e.organizer && nameMatch(l.name, e.organizer))) ?? null;
    if (!venue && e.venueName && places.findByName && lookups < MAX_EVENT_LOOKUPS) {
      lookups++;
      try {
        const p = await places.findByName(e.venueName, e.location ?? center);
        if (p) venue = await saveLead(restaurant, center, { ...p, category: "venue" }, places.name, now);
        if (venue) leads.push(venue);
      } catch {
        // A failed venue lookup just means no one to pitch for this event yet.
      }
    }
    let location = e.location ?? (venue ? { lat: venue.latitude, lng: venue.longitude } : null);
    if (!location && e.venueAddress && lookups < MAX_EVENT_LOOKUPS) {
      lookups++;
      location = await places.geocode(e.venueAddress).catch(() => null);
    }
    const distanceMiles = location ? milesBetween(center, location) : null;
    const { score, reasons, excluded } = scoreEvent(e, distanceMiles, restaurant.radiusMiles, now);
    if (excluded) return;
    const data = {
      title: e.title,
      category: e.category,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      venueName: e.venueName,
      venueAddress: e.venueAddress,
      latitude: location?.lat ?? null,
      longitude: location?.lng ?? null,
      distanceMiles,
      attendance: e.attendance,
      organizer: e.organizer,
      description: e.description ?? null,
      url: e.url,
      fitScore: score,
      scoreReasons: reasons,
      venueLeadId: venue?.id ?? null,
      fetchedAt: now,
    };
    await db.event.upsert({
      where: { restaurantId_source_externalId: { restaurantId: restaurant.id, source: e.source, externalId: e.externalId } },
      create: { restaurantId: restaurant.id, source: e.source, externalId: e.externalId, ...data },
      update: data,
    });
    counts.events++;
  };

  for (const provider of providers) {
    try {
      for (const e of await provider.upcoming(center, restaurant.radiusMiles, now, to)) await save(e);
    } catch (err) {
      counts.notes.push(`${provider.name} events failed (${short(err instanceof Error ? err.message : String(err))})`);
    }
  }
  if (web) {
    await progress(restaurant.id, "LEADS", "Searching the web for conferences, expos and company events nearby…");
    const companies = leads.filter((l) => l.category === "office" || l.category === "coworking").slice(0, 20).map((l) => l.name);
    try {
      const found = await web.find({ address, radiusMiles: restaurant.radiusMiles, from: new Date(now.getTime() + 86_400_000), to, companies });
      for (const e of found) await save(e);
      counts.notes.push(`web search found ${found.length} events`);
    } catch (err) {
      // Busy or out of quota: the businesses are still saved; events can be searched again later.
      counts.notes.push(`web event search failed (${short(err instanceof Error ? err.message : String(err))})`);
    }
  }
}

type LeadWithContacts = Lead & { contacts: Contact[] };

export function toLeadInfo(l: LeadWithContacts): LeadInfo {
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    distanceMiles: l.distanceMiles,
    fitScore: l.fitScore,
    reasons: l.scoreReasons,
    status: l.status,
    excludeReason: l.excludeReason,
    contacts: l.contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, verification: c.verification })),
  };
}

export function toEventInfo(e: EventRow, now: Date): EventInfo {
  return {
    id: e.id,
    title: e.title,
    category: e.category,
    date: e.startsAt.toISOString().slice(0, 10),
    daysAhead: Math.round((e.startsAt.getTime() - now.getTime()) / 86_400_000),
    venueName: e.venueName,
    venueLeadId: e.venueLeadId,
    attendance: e.attendance,
    distanceMiles: e.distanceMiles,
    fitScore: e.fitScore,
    reasons: e.scoreReasons,
  };
}

/** Everything a pitch email may say, built from stored data only. */
export function pitchPacket(restaurant: Restaurant, lead: Lead, contact: Contact | null, event: EventRow | null, pitch: Pick<Pitch, "offer" | "occasion">): FactsPacket {
  const offer = OFFER_TEXT[pitch.offer];
  const facts: PitchFacts = {
    company: lead.name,
    contactFirstName: contact?.name?.split(/\s+/)[0] ?? null,
    category: categoryLabel(lead.category).toLowerCase(),
    distanceMiles: lead.distanceMiles,
    offer,
    minOrder: restaurant.minCateringOrder,
    occasion: pitch.occasion,
    event: event ? { title: event.title, date: fmtDate(event.startsAt) } : null,
  };
  return {
    restaurant: { name: restaurant.name, brand: restaurant.brand, kind: restaurant.kind },
    offer: { key: `pitch:${pitch.offer}`, title: `${offer} with a first catering order`, schedule: event ? `Event on ${fmtDate(event.startsAt)}` : "Send this week", audience: lead.name, copyLabel: "Email subject" },
    facts: [
      `${offer[0].toUpperCase()}${offer.slice(1)} with a first catering order of ${restaurant.minCateringOrder} or more people`,
      `${lead.distanceMiles} mi from ${lead.name}`,
      pitch.occasion,
      ...(event ? [`${event.title} on ${fmtDate(event.startsAt)}`] : []),
    ],
    rules: { brandSafe: isBrandSafe(restaurant), maxDiscountPct: restaurant.maxDiscountPct, codePlaceholder: null },
    pitch: facts,
  };
}

type PitchMeta = { source: "AI_ANALYST" | "RULES"; analysisRunId: string | null; toolLog: LeadOutcome["toolLog"]; citations?: Suggestion["citations"] };
type DraftResult = { kind: "created"; draftId: string } | { kind: "reused"; draftId: string } | { kind: "decided" } | { kind: "failed"; message: string };

/**
 * Writes one pitch draft. Throws AiBusyError when the AI is busy, so a job
 * can wait and retry; the same facts are never drafted twice.
 */
export async function draftPitch(
  restaurant: Restaurant,
  provider: CopyProvider,
  lead: Lead & { contacts: Contact[] },
  event: EventRow | null,
  p: Pitch,
  meta: PitchMeta,
): Promise<DraftResult> {
  const planned = await planPitch(restaurant, lead, event, p, meta);
  if (planned.kind !== "plan") return planned;
  const copy = await writeOfferCopy(provider, planned.plan.packet);
  await logCall(restaurant.id, copy.log);
  if (!copy.ok) {
    if (copy.fatal) throw new AiConfigError(copy.message);
    if (copy.retryable) throw new AiBusyError(copy.message, copy.retryAfterMs);
    return { kind: "failed", message: copy.message };
  }
  return { kind: "created", draftId: await savePitch(restaurant, planned.plan, copy) };
}

export interface PitchPlan {
  lead: Lead & { contacts: Contact[] };
  event: EventRow | null;
  p: Pitch;
  meta: PitchMeta;
  contact: Contact | null;
  packet: FactsPacket;
  factsHash: string;
}

/** Everything a pitch needs except the copy; or why there's nothing to write. */
export async function planPitch(restaurant: Restaurant, lead: Lead & { contacts: Contact[] }, event: EventRow | null, p: Pitch, meta: PitchMeta): Promise<{ kind: "plan"; plan: PitchPlan } | DraftResult> {
  const contact = lead.contacts.find((c) => c.id === p.contact_id) ?? lead.contacts[0] ?? null;
  const packet = pitchPacket(restaurant, lead, contact, event, p);
  const factsHash = createHash("sha256").update(JSON.stringify({ packet, why: p.why, contact: contact?.id ?? null })).digest("hex");
  // The same facts are never written twice.
  const same = await db.draft.findUnique({ where: { restaurantId_factsHash: { restaurantId: restaurant.id, factsHash } } });
  if (same) return { kind: "reused", draftId: same.id };
  // A decided pitch stays decided; only waiting ones are replaced.
  if (await db.draft.findFirst({ where: { leadId: lead.id, eventId: event?.id ?? null, status: { in: ["APPROVED", "SKIPPED"] } } })) return { kind: "decided" };
  return { kind: "plan", plan: { lead, event, p, meta, contact, packet, factsHash } };
}

/** Saves a written pitch as a draft in the inbox. */
export async function savePitch(restaurant: Restaurant, plan: PitchPlan, copy: { copy: { headline: string; body: string }; writtenBy: string }): Promise<string> {
  const { lead, event, p, meta, contact, packet, factsHash } = plan;
  await db.draft.deleteMany({ where: { leadId: lead.id, eventId: event?.id ?? null, status: "PENDING" } });
  const checks = [
    p.offer === "free_delivery" ? "Free delivery, no price cut" : "Free extra, no price cut",
    `Within your ${restaurant.radiusMiles} mi radius`,
    ...(restaurant.kind === "FRANCHISE" ? [`Says you're ${INDEPENDENT_LINE}`] : []),
    ...(contact?.verification === "valid" ? ["Email address verified"] : []),
  ];
  const draft = await db.draft.create({
    data: {
      restaurantId: restaurant.id,
      kind: "CATERING_PITCH",
      leadId: lead.id,
      contactId: contact?.id ?? null,
      eventId: event?.id ?? null,
      offerKey: packet.offer.key,
      source: meta.source,
      confidence: meta.source === "AI_ANALYST" ? p.confidence : null,
      analysisRunId: meta.analysisRunId,
      category: event ? "Event" : categoryLabel(lead.category),
      title: lead.name,
      schedule: packet.offer.schedule,
      why: p.why,
      audience: contactLabel(contact),
      cost: `${OFFER_TEXT[p.offer][0].toUpperCase()}${OFFER_TEXT[p.offer].slice(1)} on a first order of ${restaurant.minCateringOrder}+ people`,
      measure: "Replies and first orders, once sending is turned on",
      checks,
      evidence: json({
        kind: "pitch",
        reasons: lead.scoreReasons,
        citations: meta.citations ?? citationsFor(p, meta.toolLog),
        mapsUrl: mapsUrl(lead.placeId, lead.name),
        event: event ? { title: event.title, date: fmtDate(event.startsAt), attendance: event.attendance, url: event.url, source: event.source } : null,
        occasion: p.occasion,
        offer: p.offer,
      }),
      copyLabel: "Email subject",
      facts: packet.facts,
      headline: copy.copy.headline,
      body: copy.copy.body,
      writtenBy: copy.writtenBy,
      factsHash,
    },
  });
  if (lead.status === "NEW") await db.lead.update({ where: { id: lead.id }, data: { status: "DRAFTED" } });
  return draft.id;
}

export function contactLabel(contact: Pick<Contact, "name" | "email" | "role"> | null) {
  return contact ? [contact.name ?? contact.email, contact.role].filter(Boolean).join(", ") : "No contact found yet. Add or find one before sending.";
}

async function leadContext(restaurant: Restaurant, now: Date) {
  const [leads, eventRows, { rows }, decisions] = await Promise.all([
    db.lead.findMany({ where: { restaurantId: restaurant.id }, include: { contacts: { orderBy: { createdAt: "asc" } } }, orderBy: { fitScore: "desc" }, take: 80 }),
    db.event.findMany({ where: { restaurantId: restaurant.id, startsAt: { gte: now } }, orderBy: { fitScore: "desc" }, take: 20 }),
    usableReports(restaurant.id),
    db.draft.findMany({ where: { restaurantId: restaurant.id, kind: "CATERING_PITCH", status: { in: ["APPROVED", "SKIPPED"] } }, orderBy: { decidedAt: "desc" }, take: 30 }),
  ]);
  const base = buildContext(
    restaurant,
    rows.map((r) => ({ report: r.data as unknown as ParsedReport, status: r.status === "CONFIRMED" ? "CONFIRMED" : "READ" })),
    decisions.map((d) => ({ title: d.title, status: d.status as "APPROVED" | "SKIPPED", skipReason: d.skipReason, source: d.source })),
  );
  const ctx: LeadContext = { ...base, leads: leads.map(toLeadInfo), events: eventRows.map((e) => toEventInfo(e, now)) };
  return { leads, eventRows, ctx };
}

function citationsFor(p: Pitch, log: LeadOutcome["toolLog"]) {
  return p.evidence.map((e) => {
    const out = log.find((c) => c.id === e.tool_call_id)?.output as { source?: string } | undefined;
    return { label: e.label, value: e.value, source: out?.source ?? "Area scan" };
  });
}

export type Suggestion = { leadId: string; eventId: string | null; offer: Pitch["offer"]; occasion: string; why: string; confidence: string; citations: { label: string; value: number; source: string }[] };

/**
 * One SUGGEST job: the lead analyst looks at the scanned businesses and
 * events and marks the most promising ones, with reasons. Nothing is drafted.
 * A run is reused while the leads, events and rules are unchanged.
 */
export async function suggestLeads(restaurantId: string, now = new Date()): Promise<string> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return "Restaurant not found.";
  const analyst = analystFromEnv("leads");
  if (!analyst) return "The AI analyst is off (ANALYST_PROVIDER).";
  const { leads, ctx } = await leadContext(restaurant, now);
  if (leads.length === 0) return "Scan your area first.";

  const dataHash = createHash("sha256")
    .update(JSON.stringify({ analyst: `${analyst.provider}:${analyst.model}`, leads: ctx.leads, events: ctx.events, rules: ctx.rules, restaurant: ctx.restaurant, decisions: ctx.pastDecisions }))
    .digest("hex");
  const previous = await db.analysisRun.findFirst({ where: { restaurantId, purpose: "leads", dataHash, status: "DONE" }, orderBy: { createdAt: "desc" } });
  if (previous) return "Nothing changed since the last suggestions, so they were kept.";

  const run = await db.analysisRun.create({ data: { restaurantId, purpose: "leads", provider: analyst.provider, model: analyst.model, dataHash } });
  const started = Date.now();
  const outcome = await runLeadAnalysis(analyst, ctx, {
    onTurn: (turn, lookups) => progress(restaurantId, "SUGGEST", `AI is looking through ${ctx.leads.length} businesses and ${ctx.events.length} events (step ${turn}, ${lookups} lookups)…`),
  });
  await logAnalysisCall(restaurantId, analyst, outcome, started, "lead-analysis");
  if (outcome.fatal || outcome.busy) {
    await db.analysisRun.delete({ where: { id: run.id } });
    if (outcome.fatal) throw new AiConfigError(outcome.error ?? "The AI provider rejected the request.");
    throw new AiBusyError(outcome.error ?? "The AI is busy.", outcome.busy?.retryAfterMs);
  }
  const suggestions: Suggestion[] = outcome.pitches.map((p) => ({
    leadId: p.lead_id,
    eventId: p.event_id ?? null,
    offer: p.offer,
    occasion: p.occasion,
    why: p.why,
    confidence: p.confidence,
    citations: citationsFor(p, outcome.toolLog),
  }));
  await db.analysisRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
      model: analyst.model,
      error: outcome.error ?? null,
      accepted: json({ pitches: outcome.pitches, skipped: outcome.skipped, suggestions }),
      rejected: json(outcome.rejected.map((r) => ({ kind: "pitch", ...r }))),
      toolLog: json(outcome.toolLog),
      toolCalls: outcome.toolCalls,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      estimatedCostUsd: estimateCostUsd(analyst.model, outcome.inputTokens, outcome.outputTokens),
      finishedAt: new Date(),
    },
  });
  if (outcome.status !== "DONE") return `The AI didn't finish: ${short(outcome.error ?? "unknown error")}`;
  return `AI suggested ${suggestions.length} of ${ctx.leads.filter((l) => l.status !== "EXCLUDED").length} businesses (${outcome.rejected.length} blocked by checks).`;
}

/** The latest AI suggestions, keyed by lead id. */
export async function latestSuggestions(restaurantId: string) {
  const run = await db.analysisRun.findFirst({ where: { restaurantId, purpose: "leads", status: "DONE" }, orderBy: { createdAt: "desc" } });
  const list = (run?.accepted as unknown as { suggestions?: Suggestion[] } | null)?.suggestions ?? [];
  return { runId: run?.id ?? null, at: run?.createdAt ?? null, byLead: new Map(list.map((x) => [x.leadId, x])) };
}

type Prepared = { kind: "plan"; plan: PitchPlan; note?: string } | { kind: "existing"; draftId: string } | { kind: "error"; error: string };

/**
 * Gets one requested pitch ready to write: finds who to contact (the
 * business, or an event's venue or organiser), looks up a contact with
 * Hunter if there isn't one yet, and builds the facts. No AI here.
 */
async function preparePitch(restaurant: Restaurant, target: PitchTarget, suggestions: Awaited<ReturnType<typeof latestSuggestions>>, now: Date): Promise<Prepared> {
  const offerDefault = restaurant.allowFreeExtra ? "free_cookie_platter" : restaurant.allowFreeDelivery ? "free_delivery" : null;
  const event = target.eventId ? await db.event.findFirst({ where: { id: target.eventId, restaurantId: restaurant.id } }) : null;
  if (target.eventId && !event) return { kind: "error", error: "This event is no longer in your list." };
  let leadId = target.leadId ?? event?.venueLeadId ?? null;
  if (!leadId && event) leadId = (await leadForEvent(restaurant, event)).id;
  const lead = leadId ? await db.lead.findFirst({ where: { id: leadId, restaurantId: restaurant.id }, include: { contacts: { orderBy: { createdAt: "asc" } } } }) : null;
  if (!lead) return { kind: "error", error: "This business is no longer in your list." };
  if (lead.status === "EXCLUDED") return { kind: "error", error: `${lead.name} is excluded. Include it again first.` };

  const existing = await db.draft.findFirst({ where: { leadId: lead.id, eventId: event?.id ?? null, status: { in: ["PENDING", "APPROVED"] } } });
  if (existing) return { kind: "existing", draftId: existing.id };

  // A contact first, so the email can greet the right person.
  let note: string | undefined;
  const contacts = contactsFromEnv();
  const domain = domainOf(lead.website);
  const checkedRecently = lead.contactsCheckedAt && now.getTime() - lead.contactsCheckedAt.getTime() < PLACE_TTL_MS;
  if (lead.contacts.length === 0 && contacts && isUsefulDomain(domain) && !checkedRecently) {
    try {
      const { best } = await lookupContacts(lead.id, domain, contacts, now);
      if (best) lead.contacts.push(best);
      else note = `no contact found at ${domain}`;
    } catch (err) {
      note = err instanceof QuotaError ? `contact lookup paused (${short(err.message, 80)})` : "contact lookup failed";
    }
  } else if (lead.contacts.length === 0) {
    note = `no contact yet for ${lead.name}`;
  }

  const suggestion = suggestions.byLead.get(lead.id);
  const ai = suggestion && (suggestion.eventId ?? null) === (event?.id ?? null) ? suggestion : null;
  const offer = ai ? ai.offer : offerDefault;
  if (!offer) return { kind: "error", error: "Your rules don't allow a free extra or free delivery, so there's no offer to make." };
  const pitch: Pitch = {
    lead_id: lead.id,
    contact_id: lead.contacts[0]?.id,
    event_id: event?.id,
    offer,
    occasion: ai ? ai.occasion : event ? `Staff and attendee lunches for ${event.title}` : "Team lunches",
    why: ai ? ai.why : (event ? event.scoreReasons : lead.scoreReasons).join(". "),
    confidence: ai ? (ai.confidence as Pitch["confidence"]) : "medium",
    evidence: [],
  };
  const meta: PitchMeta = ai ? { source: "AI_ANALYST", analysisRunId: suggestions.runId, toolLog: [], citations: ai.citations } : { source: "RULES", analysisRunId: null, toolLog: [] };
  const planned = await planPitch(restaurant, lead, event, pitch, meta);
  if (planned.kind === "plan") return { ...planned, note };
  if (planned.kind === "decided") return { kind: "error", error: `You already decided on a pitch to ${lead.name}.` };
  if (planned.kind === "reused" || planned.kind === "created") return { kind: "existing", draftId: planned.draftId };
  return { kind: "error", error: planned.message };
}

/**
 * One PITCH job: writes every pitch the owner asked for. All of them are
 * prepared first, then written in batches (up to 8 per AI request, with the
 * shared rules sent once), then saved. If the AI is busy, pitches already
 * written are kept and the job tries the rest later.
 */
export async function generatePitches(restaurantId: string, targets: PitchTarget[], now = new Date()): Promise<string> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) return "Restaurant not found.";
  const provider = providerFromEnv();
  if (!provider) throw new AiConfigError(`AI isn't set up. ${missingAiReason()}`);

  const suggestions = await latestSuggestions(restaurantId);
  const plans: { plan: PitchPlan; note?: string }[] = [];
  const problems: string[] = [];
  let existing = 0;
  for (const [i, target] of targets.entries()) {
    await progress(restaurantId, "PITCH", `Getting pitch ${i + 1} of ${targets.length} ready…`);
    const prepared = await preparePitch(restaurant, target, suggestions, now);
    if (prepared.kind === "plan") plans.push(prepared);
    else if (prepared.kind === "existing") existing++;
    else problems.push(prepared.error);
  }
  const room = Math.max(0, DAILY_DRAFT_CAP - (await draftsToday(restaurantId)));
  if (plans.length > room) problems.push(`${plans.length - room} not written: today's limit of ${DAILY_DRAFT_CAP} drafts`);
  const toWrite = plans.slice(0, room);

  let written = 0;
  if (toWrite.length) {
    const requests = Math.ceil(toWrite.length / 8);
    await progress(restaurantId, "PITCH", `Writing ${toWrite.length} ${toWrite.length === 1 ? "pitch" : "pitches"} (${requests} AI ${requests === 1 ? "request" : "requests"})…`);
    const results = await writeManyCopy(provider, toWrite.map(({ plan }, i) => ({ id: `p${i + 1}`, packet: plan.packet })));
    let busy: { message: string; retryAfterMs?: number } | null = null;
    for (const [i, { plan }] of toWrite.entries()) {
      const copy = results.get(`p${i + 1}`)!;
      await logCall(restaurantId, copy.log);
      if (copy.ok) {
        await savePitch(restaurant, plan, copy);
        written++;
      } else if (copy.fatal) throw new AiConfigError(copy.message);
      else if (copy.retryable) busy = { message: copy.message, retryAfterMs: copy.retryAfterMs };
      else problems.push(`${plan.lead.name}: ${short(copy.message, 100)}`);
    }
    // Written pitches are saved; the job retries the rest when the AI is free again.
    if (busy) throw new AiBusyError(busy.message, busy.retryAfterMs);
  }
  const notes = plans.map((x) => x.note).filter(Boolean);
  return [
    `Wrote ${written} ${written === 1 ? "pitch" : "pitches"}`,
    existing ? `${existing} already had one` : "",
    notes.length ? `check contacts: ${notes.join("; ")}` : "",
    ...problems,
  ]
    .filter(Boolean)
    .join("; ");
}

/** The business to pitch for an event with no known venue: found on Google by name, or made from the event itself. */
async function leadForEvent(restaurant: Restaurant, event: EventRow): Promise<Lead> {
  const places = placesFromEnv();
  const outlet = await db.outlet.findFirst({ where: { restaurantId: restaurant.id } });
  const center = outlet?.latitude != null && outlet.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null;
  const name = event.venueName ?? event.organizer;
  if (places?.findByName && name && center) {
    const p = await places.findByName(name, center).catch(() => null);
    const lead = p ? await saveLead(restaurant, center, { ...p, category: "venue" }, places.name, new Date()) : null;
    if (lead) {
      await db.event.update({ where: { id: event.id }, data: { venueLeadId: lead.id } });
      return lead;
    }
  }
  const lead = await db.lead.upsert({
    where: { restaurantId_placeId: { restaurantId: restaurant.id, placeId: `event:${event.id}` } },
    create: {
      restaurantId: restaurant.id,
      placeId: `event:${event.id}`,
      source: "event",
      name: event.organizer ?? event.venueName ?? event.title,
      category: "venue",
      types: [],
      address: event.venueAddress ?? "",
      latitude: event.latitude ?? center?.lat ?? 0,
      longitude: event.longitude ?? center?.lng ?? 0,
      distanceMiles: event.distanceMiles ?? 0,
      website: null,
      fitScore: event.fitScore,
      scoreReasons: event.scoreReasons,
      fetchedAt: new Date(),
    },
    update: {},
  });
  await db.event.update({ where: { id: event.id }, data: { venueLeadId: lead.id } });
  return lead;
}
