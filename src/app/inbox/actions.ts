"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { db } from "@/lib/db";
import { REWRITE_LIMIT, enqueueDraftJob, logCall, processDraftJobs } from "@/lib/drafts";
import { providerFromEnv, rewriteOfferCopy } from "@/lib/llm";
import { LIMITS } from "@/lib/llm/validate";
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
  revalidatePath("/inbox");
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
  if (!draft || !SKIP_REASONS.includes(reason)) return;
  await db.draft.update({ where: { id: draft.id }, data: { skipReason: reason } });
  revalidatePath("/inbox");
}

export type CopyState = { ok?: string; error?: string; headline?: string; body?: string; rewritesLeft?: number } | undefined;

export async function saveDraftCopy(_prev: CopyState, formData: FormData): Promise<CopyState> {
  const { draft } = await ownDraft(String(formData.get("id") ?? ""));
  if (!draft) return { error: "This draft no longer exists." };
  const headline = String(formData.get("headline") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!headline || !body) return { error: "The headline and message can't be empty.", headline, body };
  if (headline.length > LIMITS.headline) return { error: `Keep the headline under ${LIMITS.headline} characters.`, headline, body };
  if (body.length > LIMITS.body) return { error: `Keep the message under ${LIMITS.body} characters.`, headline, body };
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
  const packet = {
    restaurant: { name: restaurant.name, brand: restaurant.brand, kind: restaurant.kind },
    offer: { key: draft.offerKey, title: draft.title, schedule: draft.schedule, audience: draft.audience, copyLabel: draft.copyLabel },
    facts: draft.facts.length ? draft.facts : [draft.title, draft.schedule],
    rules: { brandSafe: isBrandSafe(restaurant), maxDiscountPct: restaurant.maxDiscountPct, codePlaceholder: draft.needsCode ? ("[CODE]" as const) : null },
  };

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

export async function refreshIdeas() {
  const restaurant = await requireRestaurant();
  await enqueueDraftJob(restaurant.id);
  after(() => processDraftJobs());
  revalidatePath("/inbox");
}
