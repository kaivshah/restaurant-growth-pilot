import { createHash } from "node:crypto";
import type { Contact, Event as EventRow, Lead, Restaurant } from "@prisma/client";
import { analystFromEnv, buildContext, defaultPitches, estimateCostUsd, runLeadAnalysis } from "@/lib/analyst";
import type { EventInfo, LeadContext, LeadInfo, LeadOutcome, Pitch } from "@/lib/analyst";
import { MAX_PITCHES } from "@/lib/analyst/leads";
import { type ContactsProvider, QuotaError, contactsFromEnv } from "@/lib/contacts";
import { db } from "@/lib/db";
import { DAILY_DRAFT_CAP, draftsToday, json, logAnalysisCall, logCall, progress, usableReports } from "@/lib/drafts";
import { eventsFromEnv } from "@/lib/events";
import { type LatLng, domainOf, isUsefulDomain, milesBetween } from "@/lib/geo";
import { AiBusyError, AiConfigError, type CopyProvider, type FactsPacket, type PitchFacts, missingAiReason, providerFromEnv, writeOfferCopy } from "@/lib/llm";
import { INDEPENDENT_LINE } from "@/lib/llm/validate";
import { isBrandSafe } from "@/lib/offers";
import { type Place, type PlacesProvider, SEARCHES, placesFromEnv } from "@/lib/places";
import type { ParsedReport } from "@/lib/reports";
import { categoryLabel, scoreEvent, scoreLead } from "./score";

/** Google's terms: Place content is refreshed or removed after 30 days. */
const PLACE_TTL_MS = 30 * 86_400_000;
/** A rules change or setup re-run reuses a scan newer than this instead of searching again. */
const RESCAN_AFTER_MS = 24 * 3_600_000;
/** Most Hunter domain searches per scan, to stay inside the free monthly quota. */
const MAX_CONTACT_LOOKUPS = Number(process.env.HUNTER_MAX_LOOKUPS ?? 15);
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
 * One LEADS job: find nearby businesses and events, look up contacts, let the
 * AI (or the default rule) choose who to pitch, and draft the pitch emails.
 * Returns a short summary for the job record.
 */
export async function scanArea(restaurantId: string, opts: { force?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId }, include: { outlets: true } });
  if (!restaurant) return "Restaurant not found.";
  const outlet = restaurant.outlets[0];
  if (!outlet) return "Add your store address first.";
  const places = placesFromEnv();
  const contacts = contactsFromEnv();
  const events = eventsFromEnv();
  if (!places) return "Area scan is off. Set PLACES_PROVIDER=google (with GOOGLE_MAPS_API_KEY) or PLACES_PROVIDER=fake.";

  const lastScan = await db.leadScan.findFirst({ where: { restaurantId, status: "DONE" }, orderBy: { createdAt: "desc" } });
  const recent = lastScan && now.getTime() - lastScan.createdAt.getTime() < RESCAN_AFTER_MS && outlet.geocodedAddress === outlet.address;
  const scan = await db.leadScan.create({
    data: {
      restaurantId,
      placesProvider: places.name,
      contactsProvider: contacts?.name ?? "off",
      eventsProvider: events.map((e) => e.name).join(", ") || "off",
    },
  });

  const counts: Counts = { leads: 0, contacts: 0, events: 0, notes: [] };
  try {
    if (recent && !opts.force) {
      counts.notes.push("reused the scan from the last 24 hours");
    } else {
      await progress(restaurantId, "LEADS", "Finding your store on the map…");
      const center = await locate(outlet, places);
      if (!center) throw new Error(`We couldn't find "${outlet.address}" on the map. Check the store address in setup.`);
      await progress(restaurantId, "LEADS", "Searching for offices, schools, clinics and venues nearby…");
      await findLeads(restaurant, center, places, now, counts);
      if (contacts) {
        await progress(restaurantId, "LEADS", `Found ${counts.leads} businesses. Looking up who orders food…`);
        await findContacts(restaurantId, contacts, now, counts);
      } else counts.notes.push("contact lookup is off");
      await progress(restaurantId, "LEADS", "Checking for upcoming events…");
      await findEvents(restaurant, center, places, events, now, counts);
    }
    const drafted = await draftPitches(restaurant, now);
    const message = [
      `${counts.leads} businesses, ${counts.contacts} new contacts, ${counts.events} events`,
      drafted.summary,
      ...counts.notes,
    ].join("; ");
    await db.leadScan.update({
      where: { id: scan.id },
      data: {
        status: "DONE",
        leadsFound: counts.leads,
        contactsFound: counts.contacts,
        eventsFound: counts.events,
        pitchesDrafted: drafted.created,
        message,
        finishedAt: new Date(),
      },
    });
    return `${message}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The search itself worked; only the AI step waits (or needs fixing). The retry reuses this scan.
    const searched = err instanceof AiBusyError || err instanceof AiConfigError;
    await db.leadScan.update({
      where: { id: scan.id },
      data: {
        status: err instanceof AiBusyError ? "DONE" : "FAILED",
        ...(searched ? { leadsFound: counts.leads, contactsFound: counts.contacts, eventsFound: counts.events } : {}),
        message: err instanceof AiBusyError ? `${counts.leads} businesses, ${counts.contacts} new contacts, ${counts.events} events; pitches waiting for the AI` : short(message, 300),
        finishedAt: new Date(),
      },
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
  const other = await db.lead.deleteMany({ where: { restaurantId: restaurant.id, source: { not: places.name }, status: { not: "APPROVED" } } });
  if (other.count) counts.notes.push(`removed ${other.count} businesses from an earlier ${places.name === "fake" ? "real" : "sample"} scan`);

  // Leads nobody acted on are removed once their Place data is too old to keep.
  const stale = await db.lead.deleteMany({ where: { restaurantId: restaurant.id, status: "NEW", fetchedAt: { lt: new Date(now.getTime() - PLACE_TTL_MS) } } });
  if (stale.count) counts.notes.push(`removed ${stale.count} businesses not seen for 30 days`);
}

async function findContacts(restaurantId: string, provider: ContactsProvider, now: Date, counts: Counts) {
  const leads = await db.lead.findMany({
    where: {
      restaurantId,
      status: { not: "EXCLUDED" },
      website: { not: null },
      OR: [{ contactsCheckedAt: null }, { contactsCheckedAt: { lt: new Date(now.getTime() - PLACE_TTL_MS) } }],
    },
    orderBy: { fitScore: "desc" },
    take: 40,
  });
  const done = new Set<string>();
  let lookups = 0;
  for (const lead of leads) {
    const domain = domainOf(lead.website);
    if (!isUsefulDomain(domain) || done.has(domain)) continue;
    if (lookups >= MAX_CONTACT_LOOKUPS) {
      counts.notes.push(`stopped contact lookups at ${MAX_CONTACT_LOOKUPS} for this scan`);
      break;
    }
    done.add(domain);
    lookups++;
    try {
      counts.contacts += (await lookupContacts(lead.id, domain, provider, now)).created;
    } catch (err) {
      if (err instanceof QuotaError) {
        counts.notes.push(`contact lookups paused: ${short(err.message)}`);
        break;
      }
      counts.notes.push(`contact lookup failed for ${domain}`);
    }
  }
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

async function findEvents(restaurant: Restaurant, center: LatLng, places: PlacesProvider, providers: ReturnType<typeof eventsFromEnv>, now: Date, counts: Counts) {
  await db.event.deleteMany({ where: { restaurantId: restaurant.id, OR: [{ startsAt: { lt: now } }, { source: { notIn: providers.map((p) => p.name) } }] } });
  if (providers.length === 0) {
    counts.notes.push("event sources are off");
    return;
  }
  const to = new Date(now.getTime() + 60 * 86_400_000);
  const leads = await db.lead.findMany({ where: { restaurantId: restaurant.id } });
  for (const provider of providers) {
    let found;
    try {
      found = await provider.upcoming(center, restaurant.radiusMiles, now, to);
    } catch (err) {
      counts.notes.push(`${provider.name} events failed (${short(err instanceof Error ? err.message : String(err))})`);
      continue;
    }
    for (const e of found) {
      const distanceMiles = e.location ? milesBetween(center, e.location) : null;
      const { score, reasons, excluded } = scoreEvent(e, distanceMiles, restaurant.radiusMiles, now);
      if (excluded) continue;

      // Pitch the venue: match it to a lead we have, or look it up by name.
      let venue: Lead | null = null;
      if (e.venueName) {
        const name = e.venueName.toLowerCase();
        venue = leads.find((l) => l.name.toLowerCase() === name || l.name.toLowerCase().includes(name) || name.includes(l.name.toLowerCase())) ?? null;
        if (!venue && places.findByName) {
          try {
            const p = await places.findByName(e.venueName, e.location ?? center);
            if (p) venue = await saveLead(restaurant, center, { ...p, category: "venue" }, places.name, now);
            if (venue) leads.push(venue);
          } catch {
            // A failed venue lookup just means no one to pitch for this event.
          }
        }
      }
      const data = {
        title: e.title,
        category: e.category,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        venueName: e.venueName,
        venueAddress: e.venueAddress,
        latitude: e.location?.lat ?? null,
        longitude: e.location?.lng ?? null,
        distanceMiles,
        attendance: e.attendance,
        organizer: e.organizer,
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

type PitchMeta = { source: "AI_ANALYST" | "RULES"; analysisRunId: string | null; toolLog: LeadOutcome["toolLog"] };
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
  const contact = lead.contacts.find((c) => c.id === p.contact_id) ?? lead.contacts[0] ?? null;
  const packet = pitchPacket(restaurant, lead, contact, event, p);
  const factsHash = createHash("sha256").update(JSON.stringify({ packet, why: p.why, contact: contact?.id ?? null })).digest("hex");
  const same = await db.draft.findUnique({ where: { restaurantId_factsHash: { restaurantId: restaurant.id, factsHash } } });
  if (same) return { kind: "reused", draftId: same.id };
  // A decided pitch for this lead stays decided; only waiting ones are replaced.
  if (await db.draft.findFirst({ where: { leadId: lead.id, status: { in: ["APPROVED", "SKIPPED"] } } })) return { kind: "decided" };

  const copy = await writeOfferCopy(provider, packet);
  await logCall(restaurant.id, copy.log);
  if (!copy.ok) {
    if (copy.fatal) throw new AiConfigError(copy.message);
    if (copy.retryable) throw new AiBusyError(copy.message, copy.retryAfterMs);
    return { kind: "failed", message: copy.message };
  }
  await db.draft.deleteMany({ where: { leadId: lead.id, status: "PENDING" } });
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
        citations: citationsFor(p, meta.toolLog),
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
  return { kind: "created", draftId: draft.id };
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

/** The AI's picks, then the best-scored leads it didn't pick or skip, up to MAX_PITCHES. */
export function withTopUp(aiPicks: Pitch[], skippedIds: string[], ctx: LeadContext): { pitch: Pitch; ai: boolean }[] {
  const picks = aiPicks.slice(0, MAX_PITCHES).map((pitch) => ({ pitch, ai: true }));
  const exclude = new Set([...aiPicks.map((p) => p.lead_id), ...skippedIds]);
  return [...picks, ...defaultPitches(ctx, { exclude, limit: MAX_PITCHES - picks.length }).map((pitch) => ({ pitch, ai: false }))];
}

async function draftPitches(restaurant: Restaurant, now: Date): Promise<{ created: number; summary: string }> {
  const { leads, eventRows, ctx } = await leadContext(restaurant, now);
  if (leads.length === 0) return { created: 0, summary: "no businesses to pitch yet" };
  const provider = providerFromEnv();
  if (!provider) return { created: 0, summary: `no pitches written: AI not set up. ${missingAiReason()}` };

  const chosen = await choosePitches(restaurant, ctx);
  const list = chosen.source === "AI_ANALYST" ? withTopUp(chosen.pitches, chosen.skipped, ctx) : chosen.pitches.map((pitch) => ({ pitch, ai: false }));
  const topUps = list.filter((x) => !x.ai).length;
  if (chosen.source === "AI_ANALYST" && topUps) chosen.notes.push(`${topUps} more added as top matches`);
  let created = 0;
  let reused = 0;
  const pitched = new Set<string>();
  const failed: string[] = [];

  for (const [i, { pitch: p, ai }] of list.entries()) {
    const lead = leads.find((l) => l.id === p.lead_id);
    if (!lead || lead.status === "EXCLUDED") continue;
    pitched.add(lead.id);
    if ((await draftsToday(restaurant.id)) >= DAILY_DRAFT_CAP) {
      chosen.notes.push(`stopped at the daily limit of ${DAILY_DRAFT_CAP} drafts`);
      break;
    }
    const event = p.event_id ? (eventRows.find((e) => e.id === p.event_id) ?? null) : null;
    const meta: PitchMeta = ai ? chosen : { source: "RULES", analysisRunId: null, toolLog: [] };
    await progress(restaurant.id, "LEADS", `Writing pitch ${i + 1} of ${list.length}: ${lead.name}`);
    const res = await draftPitch(restaurant, provider, lead, event, p, meta);
    if (res.kind === "created") created++;
    else if (res.kind === "reused") reused++;
    else if (res.kind === "failed") failed.push(res.message);
  }
  if (failed.length) chosen.notes.push(`couldn't write ${failed.length} ${failed.length === 1 ? "pitch" : "pitches"}: ${short(failed[0])}`);

  // Pitches no longer chosen leave the inbox if they were still waiting.
  const dropped = await db.draft.findMany({ where: { restaurantId: restaurant.id, kind: "CATERING_PITCH", status: "PENDING", leadId: { notIn: [...pitched] } }, select: { id: true, leadId: true } });
  if (dropped.length) {
    await db.draft.deleteMany({ where: { id: { in: dropped.map((d) => d.id) } } });
    await db.lead.updateMany({ where: { id: { in: dropped.map((d) => d.leadId!).filter(Boolean) }, status: "DRAFTED" }, data: { status: "NEW" } });
  }
  return {
    created,
    summary: [`drafted ${created} pitches`, reused ? `${reused} unchanged` : "", dropped.length ? `removed ${dropped.length}` : "", ...chosen.notes].filter(Boolean).join(", "),
  };
}

function citationsFor(p: Pitch, log: LeadOutcome["toolLog"]) {
  return p.evidence.map((e) => {
    const out = log.find((c) => c.id === e.tool_call_id)?.output as { source?: string } | undefined;
    return { label: e.label, value: e.value, source: out?.source ?? "Area scan" };
  });
}

type Chosen = { pitches: Pitch[]; skipped: string[]; source: "AI_ANALYST" | "RULES"; analysisRunId: string | null; toolLog: LeadOutcome["toolLog"]; notes: string[] };

/**
 * The lead analyst's choice when ANALYST_PROVIDER is set, else the default
 * rule. A run is reused while the leads, events and rules are unchanged.
 */
async function choosePitches(restaurant: Restaurant, ctx: LeadContext): Promise<Chosen> {
  const fallback = (note: string, runId: string | null = null): Chosen => ({ pitches: defaultPitches(ctx), skipped: [], source: "RULES", analysisRunId: runId, toolLog: [], notes: [note] });
  const analyst = analystFromEnv("leads");
  if (!analyst) return fallback("chose the top-scored leads (AI analyst is off)");

  const dataHash = createHash("sha256")
    .update(JSON.stringify({ analyst: `${analyst.provider}:${analyst.model}`, leads: ctx.leads, events: ctx.events, rules: ctx.rules, restaurant: ctx.restaurant, decisions: ctx.pastDecisions }))
    .digest("hex");
  const previous = await db.analysisRun.findFirst({ where: { restaurantId: restaurant.id, purpose: "leads", dataHash, status: "DONE" }, orderBy: { createdAt: "desc" } });
  if (previous) {
    const stored = previous.accepted as unknown as { pitches: Pitch[]; skipped?: { lead_id: string }[] } | null;
    return { pitches: stored?.pitches ?? [], skipped: (stored?.skipped ?? []).map((x) => x.lead_id), source: "AI_ANALYST", analysisRunId: previous.id, toolLog: (previous.toolLog as unknown as LeadOutcome["toolLog"]) ?? [], notes: ["reused the last AI choice (nothing changed)"] };
  }

  const run = await db.analysisRun.create({ data: { restaurantId: restaurant.id, purpose: "leads", provider: analyst.provider, model: analyst.model, dataHash } });
  const started = Date.now();
  const outcome = await runLeadAnalysis(analyst, ctx, {
    onTurn: (turn, lookups) => progress(restaurant.id, "LEADS", `AI is choosing who to pitch from ${ctx.leads.length} businesses (step ${turn}, ${lookups} lookups)…`),
  });
  if (outcome.fatal) {
    await db.analysisRun.update({ where: { id: run.id }, data: { status: "FAILED", error: outcome.error ?? null, model: analyst.model, finishedAt: new Date() } });
    await logAnalysisCall(restaurant.id, analyst, outcome, started, "lead-analysis");
    throw new AiConfigError(outcome.error ?? "The AI provider rejected the request.");
  }
  if (outcome.busy) {
    await db.analysisRun.delete({ where: { id: run.id } });
    await logAnalysisCall(restaurant.id, analyst, outcome, started, "lead-analysis");
    throw new AiBusyError(outcome.error ?? "The AI is busy.", outcome.busy.retryAfterMs);
  }
  await db.analysisRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
      model: analyst.model,
      error: outcome.error ?? null,
      accepted: json({ pitches: outcome.pitches, skipped: outcome.skipped }),
      rejected: json(outcome.rejected.map((r) => ({ kind: "pitch", ...r }))),
      toolLog: json(outcome.toolLog),
      toolCalls: outcome.toolCalls,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      estimatedCostUsd: estimateCostUsd(analyst.model, outcome.inputTokens, outcome.outputTokens),
      finishedAt: new Date(),
    },
  });
  await logAnalysisCall(restaurant.id, analyst, outcome, started, "lead-analysis");
  if (outcome.status !== "DONE") return fallback(`AI choice failed (${short(outcome.error ?? "unknown error")}); used the top-scored leads`, run.id);
  return {
    pitches: outcome.pitches,
    skipped: outcome.skipped.map((x) => x.lead_id),
    source: "AI_ANALYST",
    analysisRunId: run.id,
    toolLog: outcome.toolLog,
    notes: [`AI picked ${outcome.pitches.length} of ${ctx.leads.filter((l) => l.status !== "EXCLUDED").length} businesses (${outcome.rejected.length} blocked by checks, ${outcome.skipped.length} skipped)`],
  };
}
