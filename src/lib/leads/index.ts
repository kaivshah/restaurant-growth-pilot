import { createHash } from "node:crypto";
import type { Contact, Event as EventRow, Lead, Restaurant } from "@prisma/client";
import { analystFromEnv, buildContext, defaultPitches, estimateCostUsd, runLeadAnalysis } from "@/lib/analyst";
import type { EventInfo, LeadContext, LeadInfo, LeadOutcome, Pitch } from "@/lib/analyst";
import { type ContactsProvider, QuotaError, contactsFromEnv } from "@/lib/contacts";
import { db } from "@/lib/db";
import { DAILY_DRAFT_CAP, draftsToday, json, logCall, usableReports } from "@/lib/drafts";
import { eventsFromEnv } from "@/lib/events";
import { type LatLng, domainOf, isUsefulDomain, milesBetween } from "@/lib/geo";
import { type FactsPacket, type PitchFacts, providerFromEnv, writeOfferCopy } from "@/lib/llm";
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

  try {
    const counts: Counts = { leads: 0, contacts: 0, events: 0, notes: [] };
    if (recent && !opts.force) {
      counts.notes.push("reused the scan from the last 24 hours");
    } else {
      const center = await locate(outlet, places);
      if (!center) throw new Error(`We couldn't find "${outlet.address}" on the map. Check the store address in setup.`);
      await findLeads(restaurant, center, places, now, counts);
      if (contacts) await findContacts(restaurantId, contacts, now, counts);
      else counts.notes.push("contact lookup is off");
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
    await db.leadScan.update({ where: { id: scan.id }, data: { status: "FAILED", message, finishedAt: new Date() } });
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
      counts.notes.push(`${s.query} search failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (seen.size === 0 && counts.notes.length === SEARCHES.length) throw new Error(`Every area search failed: ${counts.notes[0]}`);
  for (const p of seen.values()) if (await saveLead(restaurant, center, p, places.name, now)) counts.leads++;

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
      const people = (await provider.findByDomain(domain)).slice(0, CONTACTS_PER_LEAD);
      for (const [i, c] of people.entries()) {
        const verification = i === 0 ? await provider.verify(c.email) : null;
        const existing = await db.contact.findUnique({ where: { leadId_email: { leadId: lead.id, email: c.email } } });
        if (existing) {
          if (existing.source !== "owner") await db.contact.update({ where: { id: existing.id }, data: { name: c.name, role: c.role, confidence: c.confidence, verification: verification ?? existing.verification } });
        } else {
          await db.contact.create({ data: { leadId: lead.id, name: c.name, role: c.role, email: c.email, confidence: c.confidence, verification, source: provider.name } });
          counts.contacts++;
        }
      }
      await db.lead.update({ where: { id: lead.id }, data: { contactsCheckedAt: now } });
    } catch (err) {
      if (err instanceof QuotaError) {
        counts.notes.push(`contact lookups paused: ${err.message}`);
        break;
      }
      counts.notes.push(`contact lookup failed for ${domain}`);
    }
  }
}

async function findEvents(restaurant: Restaurant, center: LatLng, places: PlacesProvider, providers: ReturnType<typeof eventsFromEnv>, now: Date, counts: Counts) {
  await db.event.deleteMany({ where: { restaurantId: restaurant.id, startsAt: { lt: now } } });
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
      counts.notes.push(`${provider.name} events failed (${err instanceof Error ? err.message : String(err)})`);
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

async function draftPitches(restaurant: Restaurant, now: Date): Promise<{ created: number; summary: string }> {
  const [leads, eventRows, { rows }, decisions] = await Promise.all([
    db.lead.findMany({ where: { restaurantId: restaurant.id }, include: { contacts: { orderBy: { createdAt: "asc" } } }, orderBy: { fitScore: "desc" }, take: 60 }),
    db.event.findMany({ where: { restaurantId: restaurant.id, startsAt: { gte: now } }, orderBy: { fitScore: "desc" }, take: 20 }),
    usableReports(restaurant.id),
    db.draft.findMany({ where: { restaurantId: restaurant.id, kind: "CATERING_PITCH", status: { in: ["APPROVED", "SKIPPED"] } }, orderBy: { decidedAt: "desc" }, take: 30 }),
  ]);
  if (leads.length === 0) return { created: 0, summary: "no businesses to pitch yet" };

  const base = buildContext(
    restaurant,
    rows.map((r) => ({ report: r.data as unknown as ParsedReport, status: r.status === "CONFIRMED" ? "CONFIRMED" : "READ" })),
    decisions.map((d) => ({ title: d.title, status: d.status as "APPROVED" | "SKIPPED", skipReason: d.skipReason, source: d.source })),
  );
  const ctx: LeadContext = { ...base, leads: leads.map(toLeadInfo), events: eventRows.map((e) => toEventInfo(e, now)) };

  const chosen = await choosePitches(restaurant, ctx);
  const provider = providerFromEnv();
  let created = 0;
  let reused = 0;
  const pitched = new Set<string>();

  for (const p of chosen.pitches) {
    const lead = leads.find((l) => l.id === p.lead_id);
    if (!lead || lead.status === "EXCLUDED") continue;
    const contact = lead.contacts.find((c) => c.id === p.contact_id) ?? lead.contacts[0] ?? null;
    const event = p.event_id ? (eventRows.find((e) => e.id === p.event_id) ?? null) : null;
    const packet = pitchPacket(restaurant, lead, contact, event, p);
    const factsHash = createHash("sha256").update(JSON.stringify({ packet, why: p.why, contact: contact?.id ?? null })).digest("hex");
    pitched.add(lead.id);
    if (await db.draft.findUnique({ where: { restaurantId_factsHash: { restaurantId: restaurant.id, factsHash } } })) {
      reused++;
      continue;
    }
    // A decided pitch for this lead stays decided; only waiting ones are replaced.
    if (await db.draft.findFirst({ where: { leadId: lead.id, status: { in: ["APPROVED", "SKIPPED"] } } })) continue;
    if ((await draftsToday(restaurant.id)) >= DAILY_DRAFT_CAP) {
      chosen.notes.push(`stopped at the daily limit of ${DAILY_DRAFT_CAP} drafts`);
      break;
    }

    const copy = await writeOfferCopy(provider, packet);
    await logCall(restaurant.id, copy.log);
    await db.draft.deleteMany({ where: { leadId: lead.id, status: "PENDING" } });
    const checks = [
      p.offer === "free_delivery" ? "Free delivery, no price cut" : "Free extra, no price cut",
      `Within your ${restaurant.radiusMiles} mi radius`,
      ...(restaurant.kind === "FRANCHISE" ? [`Says you're ${INDEPENDENT_LINE}`] : []),
      ...(contact?.verification === "valid" ? ["Email address verified"] : []),
    ];
    await db.draft.create({
      data: {
        restaurantId: restaurant.id,
        kind: "CATERING_PITCH",
        leadId: lead.id,
        contactId: contact?.id ?? null,
        eventId: event?.id ?? null,
        offerKey: packet.offer.key,
        source: chosen.source,
        confidence: chosen.source === "AI_ANALYST" ? p.confidence : null,
        analysisRunId: chosen.analysisRunId,
        category: event ? "Event" : categoryLabel(lead.category),
        title: lead.name,
        schedule: packet.offer.schedule,
        why: p.why,
        audience: contact ? [contact.name ?? contact.email, contact.role].filter(Boolean).join(", ") : "No contact found yet. Add one before sending.",
        cost: `${OFFER_TEXT[p.offer][0].toUpperCase()}${OFFER_TEXT[p.offer].slice(1)} on a first order of ${restaurant.minCateringOrder}+ people`,
        measure: "Replies and first orders, once sending is turned on",
        checks,
        evidence: json({
          kind: "pitch",
          reasons: lead.scoreReasons,
          citations: citationsFor(p, chosen.toolLog),
          mapsUrl: mapsUrl(lead.placeId, lead.name),
          event: event ? { title: event.title, date: fmtDate(event.startsAt), attendance: event.attendance, url: event.url, source: event.source } : null,
          occasion: p.occasion,
          offer: p.offer,
        }),
        copyLabel: "Email subject",
        facts: packet.facts,
        headline: copy.headline,
        body: copy.body,
        writtenBy: copy.writtenBy,
        factsHash,
      },
    });
    if (lead.status === "NEW") await db.lead.update({ where: { id: lead.id }, data: { status: "DRAFTED" } });
    created++;
  }

  // Pitches the analyst no longer chose leave the inbox if they were still waiting.
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

type Chosen = { pitches: Pitch[]; source: "AI_ANALYST" | "RULES"; analysisRunId: string | null; toolLog: LeadOutcome["toolLog"]; notes: string[] };

/**
 * The lead analyst's choice when ANALYST_PROVIDER is set, else the default
 * rule. A run is reused while the leads, events and rules are unchanged.
 */
async function choosePitches(restaurant: Restaurant, ctx: LeadContext): Promise<Chosen> {
  const fallback = (note: string, runId: string | null = null): Chosen => ({ pitches: defaultPitches(ctx), source: "RULES", analysisRunId: runId, toolLog: [], notes: [note] });
  const analyst = analystFromEnv("leads");
  if (!analyst) return fallback("chose the top-scored leads (AI analyst is off)");

  const dataHash = createHash("sha256")
    .update(JSON.stringify({ analyst: `${analyst.provider}:${analyst.model}`, leads: ctx.leads, events: ctx.events, rules: ctx.rules, restaurant: ctx.restaurant, decisions: ctx.pastDecisions }))
    .digest("hex");
  const previous = await db.analysisRun.findFirst({ where: { restaurantId: restaurant.id, purpose: "leads", dataHash, status: "DONE" }, orderBy: { createdAt: "desc" } });
  if (previous) {
    const stored = previous.accepted as unknown as { pitches: Pitch[] } | null;
    return { pitches: stored?.pitches ?? [], source: "AI_ANALYST", analysisRunId: previous.id, toolLog: (previous.toolLog as unknown as LeadOutcome["toolLog"]) ?? [], notes: ["reused the last AI choice (nothing changed)"] };
  }

  const run = await db.analysisRun.create({ data: { restaurantId: restaurant.id, purpose: "leads", provider: analyst.provider, model: analyst.model, dataHash } });
  const started = Date.now();
  const outcome = await runLeadAnalysis(analyst, ctx);
  await db.analysisRun.update({
    where: { id: run.id },
    data: {
      status: outcome.status,
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
  await db.llmCall.create({
    data: {
      restaurantId: restaurant.id,
      provider: analyst.provider,
      model: analyst.model,
      purpose: "lead-analysis",
      outcome: outcome.status === "DONE" ? "ok" : "error",
      attempts: outcome.turns,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      durationMs: Date.now() - started,
      error: outcome.error ?? null,
    },
  });
  if (outcome.status !== "DONE") return fallback(`AI choice failed (${outcome.error}); used the top-scored leads`, run.id);
  return {
    pitches: outcome.pitches,
    source: "AI_ANALYST",
    analysisRunId: run.id,
    toolLog: outcome.toolLog,
    notes: [`AI chose ${outcome.pitches.length} leads (${outcome.rejected.length} rejected by checks, ${outcome.skipped.length} skipped)`],
  };
}
