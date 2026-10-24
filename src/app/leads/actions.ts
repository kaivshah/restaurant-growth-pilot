"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { QuotaError, contactsFromEnv } from "@/lib/contacts";
import { db } from "@/lib/db";
import { domainOf, isUsefulDomain } from "@/lib/geo";
import { type PitchTarget, enqueueDraftJob, enqueuePitches, kickJobs } from "@/lib/drafts";
import { contactLabel, lookupContacts } from "@/lib/leads";
import { LEAD_SKIP_REASONS } from "@/lib/leads/score";
import { requireRestaurant } from "@/lib/restaurant";

async function ownLead(id: string) {
  const restaurant = await requireRestaurant();
  return db.lead.findFirst({ where: { id, restaurantId: restaurant.id } });
}

function done() {
  revalidatePath("/leads");
  revalidatePath("/inbox");
}

/** Keep a business out of pitches. Its waiting pitch leaves the inbox. */
export async function excludeLead(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  const reason = String(formData.get("reason") ?? "");
  if (!lead || !LEAD_SKIP_REASONS.includes(reason)) return;
  await db.lead.update({ where: { id: lead.id }, data: { status: "EXCLUDED", excludeReason: reason } });
  await db.draft.updateMany({ where: { leadId: lead.id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason, decidedAt: new Date() } });
  done();
}

/** Put an excluded business back. It can be pitched on the next scan. */
export async function includeLead(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  if (!lead) return;
  const pitched = await db.draft.findFirst({ where: { leadId: lead.id, status: "APPROVED" } });
  await db.lead.update({ where: { id: lead.id }, data: { status: pitched ? "APPROVED" : "NEW", excludeReason: null } });
  done();
}

const contactSchema = z.object({
  name: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email(),
});

export async function addLeadContact(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  const parsed = contactSchema.safeParse({
    name: String(formData.get("name") ?? "") || undefined,
    role: String(formData.get("role") ?? "") || undefined,
    email: String(formData.get("email") ?? ""),
  });
  if (!lead || !parsed.success) return;
  const { name, role, email } = parsed.data;
  await db.contact.upsert({
    where: { leadId_email: { leadId: lead.id, email } },
    create: { leadId: lead.id, email, name: name ?? null, role: role ?? null, source: "owner" },
    update: { name: name ?? null, role: role ?? null, source: "owner" },
  });
  done();
}

export type LeadActionState = { ok?: string; error?: string; href?: string } | undefined;

/** One Hunter lookup for one business, only when the owner asks. */
export async function findContact(_prev: LeadActionState, formData: FormData): Promise<LeadActionState> {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  if (!lead) return { error: "This business is no longer in your scan." };
  const provider = contactsFromEnv();
  if (!provider) return { error: 'Contact lookup is off. Set CONTACTS_PROVIDER="hunter" and HUNTER_API_KEY in .env.' };
  const domain = domainOf(lead.website);
  if (!isUsefulDomain(domain)) return { error: "This business has no website we can search. Add a contact by hand." };
  const known = await db.contact.count({ where: { leadId: lead.id } });
  if (known > 0) return { error: "Contacts are already listed for this business." };
  if (lead.contactsCheckedAt && Date.now() - lead.contactsCheckedAt.getTime() < 30 * 86_400_000) {
    return { error: `Already searched ${domain} on ${lead.contactsCheckedAt.toLocaleDateString("en-US")}; no one was found. Add a contact by hand.` };
  }
  try {
    const { best } = await lookupContacts(lead.id, domain, provider);
    if (!best) {
      done();
      return { error: `No one found at ${domain}. Add a contact by hand if you know who orders food.` };
    }
    await db.draft.updateMany({ where: { leadId: lead.id, status: "PENDING" }, data: { contactId: best.id, audience: contactLabel(best) } });
    done();
    return { ok: `Found ${contactLabel(best)}. Check the greeting in the email.` };
  } catch (err) {
    if (err instanceof QuotaError) return { error: err.message };
    return { error: `The lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * "Generate pitch" (one row) or "Generate pitches for selected": queues the
 * work and returns at once. A worker writes them in batches; the page shows
 * "Writing…" until each pitch is in the inbox.
 */
export async function queuePitches(formData: FormData) {
  const restaurant = await requireRestaurant();
  const one = String(formData.get("one") ?? "");
  const picked = one ? [one] : formData.getAll("pick").map(String);
  const targets = picked.slice(0, 40).flatMap((v): PitchTarget[] => (v.startsWith("event:") ? [{ eventId: v.slice(6) }] : v.startsWith("lead:") ? [{ leadId: v.slice(5) }] : []));
  if (!targets.length) return;
  await enqueuePitches(restaurant.id, targets);
  after(() => kickJobs());
  done();
}

/** "AI suggests": the analyst marks the most promising businesses and events, in the background. */
export async function suggestAction() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id, "SUGGEST");
  after(() => kickJobs());
  done();
}
