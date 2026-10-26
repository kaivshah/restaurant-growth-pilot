"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cancelCustomerEmails, sendDueCustomerEmails, sendOfferToCustomers } from "@/lib/customers";
import { mailFromEnv, simulateFakeReply } from "@/lib/gmail";
import { cancelSequence, checkReplies, scheduleFollowUps, sendDueEmails, startSequence } from "@/lib/outreach";
import { z } from "zod";
import { after } from "next/server";
import { db } from "@/lib/db";
import { REWRITE_LIMIT, enqueueDraftJob, logCall, kickJobs } from "@/lib/drafts";
import { missingAiReason, providerFromEnv, rewriteOfferCopy } from "@/lib/llm";
import { LIMITS, bodyLimit } from "@/lib/llm/validate";
import { packetForDraft } from "@/lib/leads";
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
  // Once the first email has gone out, the pitch can be stopped but not un-approved.
  if (status !== "APPROVED" && draft.kind === "CATERING_PITCH" && (await db.outboundEmail.count({ where: { draftId: draft.id, status: "SENT" } }))) return;
  if (status !== "APPROVED" && draft.kind === "CUSTOMER_OFFER" && (await db.customerEmail.count({ where: { draftId: draft.id, status: "SENT" } }))) return;
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
  if (draft.kind === "CATERING_PITCH") {
    if (status === "APPROVED") await startSequence(draft.id);
    else await cancelSequence(draft.id, "Approval undone");
  }
  if (draft.kind === "CUSTOMER_OFFER" && status !== "APPROVED") {
    await cancelCustomerEmails(draft.id, "Approval undone");
  }
  revalidatePath("/inbox");
  revalidatePath("/leads");
  revalidatePath("/pipeline");
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
  // Emails not sent yet go to the new address; an approved pitch waiting for a contact starts now.
  await db.outboundEmail.updateMany({ where: { draftId: draft.id, status: "SCHEDULED" }, data: { toEmail: contact.email.toLowerCase() } });
  if (draft.status === "APPROVED") await startSequence(draft.id);
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
  const packet = draft.kind === "CATERING_PITCH" ? await packetForDraft(restaurant, draft) : {
    restaurant: { name: restaurant.name, brand: restaurant.brand, kind: restaurant.kind },
    offer: { key: draft.offerKey, title: draft.title, schedule: draft.schedule, audience: draft.audience, copyLabel: draft.copyLabel },
    facts: draft.facts.length ? draft.facts : [draft.title, draft.schedule],
    rules: { brandSafe: isBrandSafe(restaurant), maxDiscountPct: restaurant.maxDiscountPct, codePlaceholder: draft.needsCode ? ("[CODE]" as const) : null },
  };

  if (!packet) return { error: "This business is no longer in your area scan.", ...current };
  const provider = providerFromEnv();
  if (!provider) return { error: `AI isn't set up. ${missingAiReason()}`, ...current };
  const result = await rewriteOfferCopy(provider, packet, current, instruction);
  await logCall(restaurant.id, result.log);
  if (!result.ok) return { error: result.message, ...current };

  const updated = await db.draft.update({
    where: { id: draft.id },
    data: { ...result.copy, writtenBy: result.writtenBy, rewriteCount: { increment: 1 } },
  });
  revalidatePath("/inbox");
  return { ok: "Rewritten. Review it, then save or approve.", ...result.copy, rewritesLeft: REWRITE_LIMIT - updated.rewriteCount };
}


/** "Scan my area": search again now, even if the last scan is recent. */
export async function scanMyArea() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id, "LEADS", true);
  after(() => kickJobs());
  revalidatePath("/inbox");
  revalidatePath("/leads");
}

export async function refreshIdeas() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id);
  after(() => kickJobs());
  revalidatePath("/inbox");
}

// ---------- Sending, follow-ups and the pipeline (milestone 3b) ----------

/** Stop a pitch's remaining emails (the ones already sent stay sent). */
export async function stopSequence(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  await cancelSequence(draft.id);
  revalidatePath("/inbox");
  revalidatePath("/pipeline");
}

/** Retry starting a sequence, e.g. after adding a contact or connecting Gmail. */
export async function startSending(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  await startSequence(draft.id);
  revalidatePath("/inbox");
}

export type FollowUpState = { ok?: string; error?: string } | undefined;

/** The owner edits the follow-ups before they go out. */
export async function saveFollowUps(_prev: FollowUpState, formData: FormData): Promise<FollowUpState> {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return { error: "This pitch no longer exists." };
  const bodies = [String(formData.get("followup1") ?? "").trim(), String(formData.get("followup2") ?? "").trim()];
  if (bodies.some((b) => b.length > 1200)) return { error: "Keep each follow-up under 1,200 characters." };
  await db.draft.update({ where: { id: draft.id }, data: { followUps: bodies.map((body, i) => ({ day: [4, 10][i], body })).filter((f) => f.body) } });
  await scheduleFollowUps(draft.id);
  // An emptied follow-up doesn't go out.
  const steps = (["FOLLOWUP_1", "FOLLOWUP_2"] as const).filter((_, i) => !bodies[i]);
  if (steps.length) await db.outboundEmail.updateMany({ where: { draftId: draft.id, step: { in: [...steps] }, status: "SCHEDULED" }, data: { status: "CANCELLED", error: "Removed by you" } });
  revalidatePath("/inbox");
  return { ok: "Follow-ups saved." };
}

const STAGES = ["CONTACTED", "REPLIED", "QUOTE", "WON", "LOST"] as const;

/** Move a deal along the pipeline (or mark that the owner dealt with a reply). */
export async function setStage(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  const stage = String(formData.get("stage") ?? "") as (typeof STAGES)[number];
  if (!draft || !STAGES.includes(stage)) return;
  await db.draft.update({ where: { id: draft.id }, data: { stage, stageUpdatedAt: new Date(), replyHandled: stage !== "REPLIED" ? true : draft.replyHandled } });
  // Talking to them now: no more automatic follow-ups.
  if (stage !== "CONTACTED") await db.outboundEmail.updateMany({ where: { draftId: draft.id, status: "SCHEDULED" }, data: { status: "CANCELLED", error: `Moved to ${stage.toLowerCase()}` } });
  revalidatePath("/inbox");
  revalidatePath("/pipeline");
}

/** Development only (GMAIL_PROVIDER=fake): pretend the business answered. */
export async function simulateReply(formData: FormData) {
  if (mailFromEnv()?.name !== "fake") return;
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  const first = await db.outboundEmail.findFirst({ where: { draftId: draft.id, step: "FIRST", status: "SENT" } });
  if (!first?.gmailThreadId) return;
  const text = String(formData.get("text") ?? "") || "Thanks for reaching out! We have a team lunch for 25 people on the 14th. Could you send a menu and a quote?";
  await simulateFakeReply(first.gmailThreadId, first.toEmail, text);
  await checkReplies(new Date(), 0);
  revalidatePath("/inbox");
  revalidatePath("/pipeline");
}

/** Development only: send due emails now instead of waiting for the slot. */
export async function sendNowForTesting(formData: FormData) {
  if (mailFromEnv()?.name !== "fake") return;
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  await db.outboundEmail.updateMany({ where: { draftId: draft.id, step: "FIRST", status: "SCHEDULED" }, data: { scheduledFor: new Date() } });
  await sendDueEmails();
  revalidatePath("/inbox");
  revalidatePath("/pipeline");
}

// ---------- Customer offers ----------

const audienceSchema = z.enum(["all", "regulars", "lapsed"]);

export async function sendToCustomers(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  const audience = audienceSchema.safeParse(formData.get("audience"));
  if (!draft || !audience.success) return;
  const res = await sendOfferToCustomers(draft.id, audience.data);
  revalidatePath("/customers");
  const note = res.ok ? `Scheduled ${res.count} ${res.count === 1 ? "email" : "emails"}.` : res.reason;
  redirect(`/inbox?d=${draft.id}&note=${encodeURIComponent(note)}`);
}

export async function stopCustomerSends(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return;
  await cancelCustomerEmails(draft.id);
  revalidatePath("/inbox");
  revalidatePath("/customers");
}

/** Development only: send scheduled customer emails now instead of waiting for the slot. */
export async function sendCustomerEmailsNow(formData: FormData) {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft || mailFromEnv()?.name !== "fake") return;
  await db.customerEmail.updateMany({ where: { draftId: draft.id, status: "SCHEDULED" }, data: { scheduledFor: new Date() } });
  await sendDueCustomerEmails(200);
  revalidatePath("/inbox");
  revalidatePath("/customers");
}
