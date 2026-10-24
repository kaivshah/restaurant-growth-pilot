"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { after } from "next/server";
import { db } from "@/lib/db";
import { REWRITE_LIMIT, enqueueDraftJob, logCall, processDraftJobs } from "@/lib/drafts";
import { providerFromEnv, rewriteOfferCopy } from "@/lib/llm";
import { LIMITS, bodyLimit } from "@/lib/llm/validate";
import { pitchPacket } from "@/lib/leads";
import { LEAD_SKIP_REASONS } from "@/lib/leads/score";
import { isBrandSafe } from "@/lib/offers";
import { requireRestaurant } from "@/lib/restaurant";

async function ownDraft(id: string) {
  const restaurant = await requireRestaurant();
  const draft = await db.draft.findFirst({ where: { id, restaurantId: restaurant.id } });
  return { restaurant, draft };
}

async function setStatus(formData: FormData, status: "PENDING" | "APPROVED" | "SKIPPED") {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  await db.draft.update({
    where: { id: draft.id },
    data: { status, decidedAt: status === "PENDING" ? null : new Date(), skipReason: status === "SKIPPED" ? draft.skipReason : null },
  });
  // A pitch decision is also a decision about the business.
  if (draft.leadId) {
    await db.lead.update({
      where: { id: draft.leadId },
      data: status === "APPROVED" ? { status: "APPROVED" } : status === "PENDING" ? { status: "DRAFTED", excludeReason: null } : {},
    });
  }
  revalidatePath("/inbox");
  revalidatePath("/leads");
}

export async function approveDraft(formData: FormData) {
  await setStatus(formData, "APPROVED");
}

export async function skipDraft(formData: FormData) {
  await setStatus(formData, "SKIPPED");
}

export async function undoDraft(formData: FormData) {
  await setStatus(formData, "PENDING");
}

const SKIP_REASONS = ["Not right for my store", "Too generous", "Wrong timing", "Brand wouldn't allow it"];

export async function setSkipReason(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  const reason = String(formData.get("reason") ?? "");
  if (!draft || !(draft.leadId ? LEAD_SKIP_REASONS : SKIP_REASONS).includes(reason)) return;
  await db.draft.update({ where: { id: draft.id }, data: { skipReason: reason } });
  // A wrong contact is fixable; the other reasons rule the business out.
  if (draft.leadId && reason !== "Contact looks wrong") {
    await db.lead.update({ where: { id: draft.leadId }, data: { status: "EXCLUDED", excludeReason: reason } });
  }
  revalidatePath("/inbox");
  revalidatePath("/leads");
}

export type ContactState = { ok?: string; error?: string } | undefined;

const contactSchema = z.object({
  name: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
});

/** The owner adds or corrects the person a pitch goes to. */
export async function setPitchContact(_prev: ContactState, formData: FormData): Promise<ContactState> {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft?.leadId) return { error: "This pitch no longer exists." };
  const parsed = contactSchema.safeParse({
    name: String(formData.get("name") ?? "") || undefined,
    role: String(formData.get("role") ?? "") || undefined,
    email: String(formData.get("email") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { name, role, email } = parsed.data;
  const contact = await db.contact.upsert({
    where: { leadId_email: { leadId: draft.leadId, email } },
    create: { leadId: draft.leadId, email, name: name ?? null, role: role ?? null, source: "owner" },
    update: { name: name ?? null, role: role ?? null, source: "owner" },
  });
  await db.draft.update({
    where: { id: draft.id },
    data: { contactId: contact.id, audience: [contact.name ?? contact.email, contact.role].filter(Boolean).join(", ") },
  });
  revalidatePath("/inbox");
  revalidatePath("/leads");
  return { ok: "Contact saved. Check the greeting in the email still fits." };
}

export type CopyState = { ok?: string; error?: string; headline?: string; body?: string; rewritesLeft?: number } | undefined;

export async function saveDraftCopy(_prev: CopyState, formData: FormData): Promise<CopyState> {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return { error: "This draft no longer exists." };
  const headline = String(formData.get("headline") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!headline || !body) return { error: "The headline and message can't be empty.", headline, body };
  if (headline.length > LIMITS.headline) return { error: `Keep the headline under ${LIMITS.headline} characters.`, headline, body };
  const maxBody = bodyLimit(draft.kind === "CATERING_PITCH");
  if (body.length > maxBody) return { error: `Keep the message under ${maxBody} characters.`, headline, body };
  if ((draft.needsCode || draft.body.includes("[CODE]")) && !body.includes("[CODE]")) {
    return { error: "Keep [CODE] in the message. It's replaced with each customer's redemption code.", headline, body };
  }
  await db.draft.update({ where: { id: draft.id }, data: { headline, body } });
  revalidatePath("/inbox");
  return { ok: "Saved.", headline, body };
}

export async function rewriteDraft(_prev: CopyState, formData: FormData): Promise<CopyState> {
  const { restaurant, draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return { error: "This draft no longer exists." };
  const instruction = String(formData.get("instruction") ?? "").trim();
  const current = { headline: String(formData.get("headline") ?? draft.headline), body: String(formData.get("body") ?? draft.body) };
  if (!instruction) return { error: "Tell the AI what to change, or pick one of the suggestions.", ...current };
  if (draft.rewriteCount >= REWRITE_LIMIT) {
    return { error: `You've used all ${REWRITE_LIMIT} AI rewrites for this draft. You can still edit it yourself.`, ...current, rewritesLeft: 0 };
  }

  // Rewrite within the facts the draft was written from, so it can't add new claims.
  const packet = draft.kind === "CATERING_PITCH" ? await storedPitchPacket(restaurant, draft) : {
    restaurant: { name: restaurant.name, brand: restaurant.brand, kind: restaurant.kind },
    offer: { key: draft.offerKey, title: draft.title, schedule: draft.schedule, audience: draft.audience, copyLabel: draft.copyLabel },
    facts: draft.facts.length ? draft.facts : [draft.title, draft.schedule],
    rules: { brandSafe: isBrandSafe(restaurant), maxDiscountPct: restaurant.maxDiscountPct, codePlaceholder: draft.needsCode ? ("[CODE]" as const) : null },
  };

  if (!packet) return { error: "This business is no longer in your area scan.", ...current };
  const result = await rewriteOfferCopy(providerFromEnv(), packet, current, instruction);
  await logCall(restaurant.id, result.log);
  if (!result.ok) return { error: result.message, ...current };

  const updated = await db.draft.update({
    where: { id: draft.id },
    data: { ...result.copy, writtenBy: result.writtenBy, rewriteCount: { increment: 1 } },
  });
  revalidatePath("/inbox");
  return { ok: "Rewritten. Review it, then save or approve.", ...result.copy, rewritesLeft: REWRITE_LIMIT - updated.rewriteCount };
}

async function storedPitchPacket(restaurant: Awaited<ReturnType<typeof requireRestaurant>>, draft: { leadId: string | null; contactId: string | null; eventId: string | null; evidence: unknown }) {
  if (!draft.leadId) return null;
  const [lead, contact, event] = await Promise.all([
    db.lead.findUnique({ where: { id: draft.leadId } }),
    draft.contactId ? db.contact.findUnique({ where: { id: draft.contactId } }) : null,
    draft.eventId ? db.event.findUnique({ where: { id: draft.eventId } }) : null,
  ]);
  const ev = draft.evidence as { offer?: "free_cookie_platter" | "free_drinks_tray" | "free_delivery"; occasion?: string } | null;
  if (!lead || !ev?.offer || !ev.occasion) return null;
  return pitchPacket(restaurant, lead, contact, event, { offer: ev.offer, occasion: ev.occasion });
}

/** "Scan my area": search again now, even if the last scan is recent. */
export async function scanMyArea() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id, "LEADS", true);
  after(() => processDraftJobs());
  revalidatePath("/inbox");
  revalidatePath("/leads");
}

export async function refreshIdeas() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id);
  after(() => processDraftJobs());
  revalidatePath("/inbox");
}
