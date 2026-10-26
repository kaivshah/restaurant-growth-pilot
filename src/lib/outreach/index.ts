import type { Draft, EmailStep, OutboundEmail, PipelineStage, Restaurant } from "@prisma/client";
import { signToken, verifyToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { enqueueFollowUps, logCall } from "@/lib/drafts";
import { MailAccountError, MailRetryError, accessTokenFor, appUrl, mailFromEnv } from "@/lib/gmail";
import { buildRaw } from "@/lib/gmail/mime";
import { packetForDraft } from "@/lib/leads";
import { AiBusyError, AiConfigError, ProviderError, providerFromEnv, validateCopy } from "@/lib/llm";
import { INDEPENDENT_LINE } from "@/lib/llm/validate";
import { pacificDay } from "@/lib/llm/usage";
import { FOLLOW_UP_DAYS, nextSendSlot } from "./schedule";

/**
 * Catering outreach after the owner approves a pitch:
 *
 *   approve ─▶ first email in the next send slot ─▶ follow-up day 4 ─▶ follow-up day 10
 *                                │  a reply, unsubscribe or bounce stops the rest
 *                                ▼
 *                 CONTACTED ─▶ REPLIED ─▶ QUOTE ─▶ WON / LOST   (pipeline)
 *
 * Emails go out from the owner's Gmail on weekday mornings, spaced out and
 * capped per day. Every email carries an unsubscribe link and the outlet's
 * postal address (CAN-SPAM).
 */

const DAY = 86_400_000;
const STOPPED: PipelineStage[] = ["REPLIED", "QUOTE", "WON", "LOST", "UNSUBSCRIBED", "BOUNCED"];
const STEP_DAYS: Record<EmailStep, number> = { FIRST: 0, FOLLOWUP_1: FOLLOW_UP_DAYS[0], FOLLOWUP_2: FOLLOW_UP_DAYS[1] };

// ---------- Unsubscribe ----------

export function unsubscribeToken(restaurantId: string, email: string) {
  return signToken(`${restaurantId}|${email.toLowerCase()}`);
}

export function readUnsubscribeToken(token: string): { restaurantId: string; email: string } | null {
  const payload = verifyToken(token);
  const [restaurantId, email] = payload?.split("|") ?? [];
  return restaurantId && email ? { restaurantId, email } : null;
}

/** Stops all email to this address from this restaurant, now and later. */
export async function suppress(restaurantId: string, email: string, reason: string) {
  const address = email.toLowerCase();
  await db.suppression.upsert({ where: { restaurantId_email: { restaurantId, email: address } }, create: { restaurantId, email: address, reason }, update: {} });
  await db.outboundEmail.updateMany({ where: { restaurantId, toEmail: address, status: "SCHEDULED" }, data: { status: "CANCELLED", error: `Stopped: ${reason}` } });
  if (reason === "unsubscribed" || reason === "replied-stop" || reason === "bounced") {
    const stage: PipelineStage = reason === "bounced" ? "BOUNCED" : "UNSUBSCRIBED";
    const drafts = await db.draft.findMany({ where: { restaurantId, contact: { email: address }, stage: { notIn: ["WON", "LOST"] } }, select: { id: true } });
    await db.draft.updateMany({ where: { id: { in: drafts.map((d) => d.id) } }, data: { stage, stageUpdatedAt: new Date() } });
  }
}

export async function isSuppressed(restaurantId: string, email: string) {
  return Boolean(await db.suppression.findUnique({ where: { restaurantId_email: { restaurantId, email: email.toLowerCase() } } }));
}

/** The lines added under every email: who it's from, where, and how to stop. */
export function emailFooter(restaurant: Pick<Restaurant, "id" | "name" | "kind">, address: string, toEmail: string, body: string) {
  const lines = ["", "--", `${restaurant.name}${address ? ` · ${address}` : ""}`];
  if (restaurant.kind === "FRANCHISE" && !body.toLowerCase().includes(INDEPENDENT_LINE)) lines.push(`${restaurant.name} is ${INDEPENDENT_LINE}.`);
  lines.push(`Don't want these emails? Unsubscribe: ${appUrl()}/u/${unsubscribeToken(restaurant.id, toEmail)}`);
  return lines.join("\n");
}

// ---------- Starting and stopping a sequence ----------

async function takenTimes(restaurantId: string) {
  const rows = await db.outboundEmail.findMany({
    where: { restaurantId, OR: [{ status: "SCHEDULED" }, { status: "SENT", sentAt: { gte: new Date(Date.now() - DAY) } }] },
    select: { scheduledFor: true, sentAt: true },
  });
  return rows.map((r) => r.sentAt ?? r.scheduledFor);
}

export type StartResult = { ok: true; firstAt: Date; from: string } | { ok: false; reason: string };

/**
 * After approval: schedule the first email in the next send slot, and the
 * follow-ups if they're written (else they're written in the background and
 * scheduled then). Safe to call again: an existing sequence is kept.
 */
export async function startSequence(draftId: string, now = new Date()): Promise<StartResult> {
  const draft = await db.draft.findUnique({ where: { id: draftId }, include: { contact: true, restaurant: { include: { gmail: true } }, emails: true } });
  if (!draft || draft.kind !== "CATERING_PITCH" || draft.status !== "APPROVED") return { ok: false, reason: "Only approved pitches are sent." };
  const restaurant = draft.restaurant;
  if (!draft.contact) return { ok: false, reason: "Add a contact email first; it sends as soon as there is one." };
  if (await isSuppressed(restaurant.id, draft.contact.email)) return { ok: false, reason: `${draft.contact.email} unsubscribed or bounced, so it won't be emailed.` };
  if (!restaurant.gmail) return { ok: false, reason: "Connect Gmail in Email settings; approved pitches start sending once it's connected." };
  const live = draft.emails.filter((e) => e.status !== "CANCELLED");
  const first = live.find((e) => e.step === "FIRST");
  if (first) return { ok: true, firstAt: first.sentAt ?? first.scheduledFor, from: restaurant.gmail.email };

  const firstAt = nextSendSlot(new Date(now.getTime() + 2 * 60_000), await takenTimes(restaurant.id), { dailyCap: restaurant.sendDailyCap });
  await db.outboundEmail.upsert({
    where: { draftId_step: { draftId, step: "FIRST" } },
    create: { restaurantId: restaurant.id, draftId, step: "FIRST", toEmail: draft.contact.email.toLowerCase(), subject: draft.headline, body: draft.body, scheduledFor: firstAt },
    update: { status: "SCHEDULED", toEmail: draft.contact.email.toLowerCase(), subject: draft.headline, body: draft.body, scheduledFor: firstAt, error: null, attempts: 0, sentAt: null },
  });
  await db.draft.update({ where: { id: draftId }, data: { stage: "SCHEDULED", stageUpdatedAt: now } });
  if (followUpsOf(draft).length) await scheduleFollowUps(draftId);
  else if (providerFromEnv()?.writeFollowUps) await enqueueFollowUps(restaurant.id, [draftId]);
  return { ok: true, firstAt, from: restaurant.gmail.email };
}

/** Undo or "stop sending": nothing more goes out for this pitch. */
export async function cancelSequence(draftId: string, reason = "Stopped by you") {
  await db.outboundEmail.updateMany({ where: { draftId, status: "SCHEDULED" }, data: { status: "CANCELLED", error: reason } });
  const sent = await db.outboundEmail.count({ where: { draftId, status: "SENT" } });
  if (!sent) await db.draft.update({ where: { id: draftId }, data: { stage: "NONE", stageUpdatedAt: new Date() } });
}

/** Starts every approved pitch that was waiting for Gmail to be connected. */
export async function startWaitingSequences(restaurantId: string) {
  const waiting = await db.draft.findMany({ where: { restaurantId, kind: "CATERING_PITCH", status: "APPROVED", stage: "NONE" }, select: { id: true } });
  for (const d of waiting) await startSequence(d.id);
  return waiting.length;
}

export function followUpsOf(draft: Pick<Draft, "followUps">): { day: number; body: string }[] {
  const list = draft.followUps as { day: number; body: string }[] | null;
  return Array.isArray(list) ? list.filter((f) => f && typeof f.body === "string" && f.body.trim()) : [];
}

/** Schedules follow-ups relative to the first email, if the pitch is still going. */
export async function scheduleFollowUps(draftId: string) {
  const draft = await db.draft.findUnique({ where: { id: draftId }, include: { emails: true, restaurant: true } });
  if (!draft || STOPPED.includes(draft.stage)) return;
  const first = draft.emails.find((e) => e.step === "FIRST" && e.status !== "CANCELLED");
  if (!first) return;
  const base = first.sentAt ?? first.scheduledFor;
  const steps: EmailStep[] = ["FOLLOWUP_1", "FOLLOWUP_2"];
  for (const [i, f] of followUpsOf(draft).slice(0, 2).entries()) {
    const step = steps[i];
    const existing = draft.emails.find((e) => e.step === step);
    if (existing && existing.status !== "CANCELLED") {
      if (existing.status === "SCHEDULED") await db.outboundEmail.update({ where: { id: existing.id }, data: { body: f.body } });
      continue;
    }
    const at = nextSendSlot(new Date(base.getTime() + STEP_DAYS[step] * DAY), await takenTimes(draft.restaurantId), { dailyCap: draft.restaurant.sendDailyCap });
    const data = { restaurantId: draft.restaurantId, toEmail: first.toEmail, subject: `Re: ${first.subject}`, body: f.body, scheduledFor: at };
    await db.outboundEmail.upsert({ where: { draftId_step: { draftId, step } }, create: { draftId, step, ...data }, update: { ...data, status: "SCHEDULED", error: null, attempts: 0, sentAt: null } });
  }
}

// ---------- Writing follow-ups (FOLLOWUPS job) ----------

/** Writes the day-4 and day-10 follow-ups for approved pitches, up to 8 per AI request. */
export async function writeFollowUps(restaurantId: string, draftIds: string[]): Promise<string> {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  const provider = providerFromEnv();
  if (!restaurant || !provider?.writeFollowUps) return "Follow-ups need an AI provider; the first email still goes out.";
  const drafts = (await db.draft.findMany({ where: { id: { in: draftIds }, restaurantId, status: "APPROVED" } })).filter((d) => !followUpsOf(d).length);
  const items = [];
  for (const d of drafts) {
    const packet = await packetForDraft(restaurant, d);
    if (packet) items.push({ id: d.id, packet, first: { subject: d.headline, body: d.body } });
  }
  let written = 0;
  for (let i = 0; i < items.length; i += 8) {
    const chunk = items.slice(i, i + 8);
    const started = Date.now();
    try {
      const res = await provider.writeFollowUps(chunk, AbortSignal.timeout(90_000));
      await logCall(restaurantId, { provider: provider.name, model: provider.model, purpose: "write", outcome: "ok", attempts: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens, durationMs: Date.now() - started });
      for (const { id, packet } of chunk) {
        const got = res.items.find((x) => x.id === id);
        // Same checks as any copy: no invented prices or discounts (the footer adds the franchise line).
        const plain = { ...packet, pitch: undefined };
        const ok = got && [got.followup1, got.followup2].every((b) => b.trim() && validateCopy({ headline: "Follow-up", body: b }, plain).length === 0);
        if (!ok) continue;
        await db.draft.update({ where: { id }, data: { followUps: [{ day: FOLLOW_UP_DAYS[0], body: got.followup1.trim() }, { day: FOLLOW_UP_DAYS[1], body: got.followup2.trim() }] } });
        await scheduleFollowUps(id);
        written++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCall(restaurantId, { provider: provider.name, model: provider.model, purpose: "write", outcome: "error", attempts: 1, durationMs: Date.now() - started, error: message });
      if (err instanceof AiConfigError) throw err;
      if (!(err instanceof ProviderError) || err.retryable) throw new AiBusyError(message, err instanceof ProviderError ? err.retryAfterMs : undefined);
    }
  }
  return `Wrote follow-ups for ${written} of ${drafts.length} ${drafts.length === 1 ? "pitch" : "pitches"}`;
}

// ---------- Sending (worker) ----------

/** Emails already sent today (Pacific day) by this restaurant, for the daily cap. */
async function sentToday(restaurantId: string, now: Date) {
  const rows = await db.outboundEmail.findMany({ where: { restaurantId, status: "SENT", sentAt: { gte: new Date(now.getTime() - DAY) } }, select: { sentAt: true } });
  return rows.filter((r) => r.sentAt && pacificDay(r.sentAt) === pacificDay(now)).length;
}

async function claimDue(limit: number): Promise<OutboundEmail[]> {
  return db.$queryRaw<OutboundEmail[]>`
    UPDATE "OutboundEmail" SET status = 'SENDING', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "OutboundEmail" WHERE status = 'SCHEDULED' AND "scheduledFor" <= now()
      ORDER BY "scheduledFor" LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

const later = (id: string, ms: number, error: string) => db.outboundEmail.update({ where: { id }, data: { status: "SCHEDULED", scheduledFor: new Date(Date.now() + ms), error } });

/** Sends emails whose time has come. Safe to run from several workers at once. */
export async function sendDueEmails(limit = 10, now = new Date()): Promise<number> {
  const mail = mailFromEnv();
  const due = await claimDue(limit);
  let sent = 0;
  for (const email of due) {
    const draft = await db.draft.findUnique({ where: { id: email.draftId }, include: { restaurant: { include: { outlets: true } }, emails: true } });
    if (!draft || draft.status !== "APPROVED" || STOPPED.includes(draft.stage)) {
      await db.outboundEmail.update({ where: { id: email.id }, data: { status: "CANCELLED", error: "The pitch was stopped or answered." } });
      continue;
    }
    const restaurant = draft.restaurant;
    if (await isSuppressed(restaurant.id, email.toEmail)) {
      await db.outboundEmail.update({ where: { id: email.id }, data: { status: "CANCELLED", error: "Unsubscribed or bounced." } });
      continue;
    }
    if (!mail) {
      await later(email.id, 3_600_000, "Gmail sending isn't configured (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).");
      continue;
    }
    if ((await sentToday(restaurant.id, now)) >= restaurant.sendDailyCap) {
      const next = nextSendSlot(new Date(now.getTime() + 60_000), await takenTimes(restaurant.id), { dailyCap: restaurant.sendDailyCap });
      await db.outboundEmail.update({ where: { id: email.id }, data: { status: "SCHEDULED", scheduledFor: next, error: `Daily limit of ${restaurant.sendDailyCap} reached` } });
      continue;
    }
    const first = draft.emails.find((e) => e.step === "FIRST");
    if (email.step !== "FIRST" && (!first || first.status !== "SENT" || !first.gmailThreadId)) {
      if (!first || first.status === "CANCELLED" || first.status === "FAILED") await db.outboundEmail.update({ where: { id: email.id }, data: { status: "CANCELLED", error: "The first email wasn't sent." } });
      else await later(email.id, 3_600_000, "Waiting for the first email.");
      continue;
    }
    try {
      const { email: from, token } = await accessTokenFor(restaurant.id);
      const body = `${email.body}\n${emailFooter(restaurant, restaurant.outlets[0]?.address ?? "", email.toEmail, email.body)}`;
      const raw = buildRaw({
        from: `${restaurant.name} <${from}>`,
        to: email.toEmail,
        subject: email.subject,
        body,
        inReplyTo: email.step === "FIRST" ? undefined : (first?.rfcMessageId ?? undefined),
        unsubscribeUrl: `${appUrl()}/api/unsubscribe/${unsubscribeToken(restaurant.id, email.toEmail)}`,
        unsubscribeMailto: from,
      });
      const res = await mail.send(token, raw, email.step === "FIRST" ? null : first?.gmailThreadId);
      await db.outboundEmail.update({
        where: { id: email.id },
        data: { status: "SENT", sentAt: new Date(), gmailMessageId: res.id, gmailThreadId: res.threadId, rfcMessageId: res.rfcMessageId, error: null },
      });
      if (email.step === "FIRST") await db.draft.update({ where: { id: draft.id }, data: { stage: "CONTACTED", stageUpdatedAt: new Date() } });
      console.log(`[mail] sent ${email.step.toLowerCase()} for ${draft.title} to ${email.toEmail}`);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[mail] couldn't send to ${email.toEmail}: ${message}`);
      if (err instanceof MailAccountError) await later(email.id, 3_600_000, message);
      else if (err instanceof MailRetryError) await later(email.id, 10 * 60_000, message);
      else if (email.attempts >= 3) await db.outboundEmail.update({ where: { id: email.id }, data: { status: "FAILED", error: message } });
      else await later(email.id, 15 * 60_000, message);
    }
  }
  return sent;
}

// ---------- Replies (worker) ----------

const STOP_WORDS = /\b(unsubscribe|remove me|stop (emailing|sending)|take me off|do not (contact|email))\b/i;
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (sub)?system/i;

export type ReplyKind = "reply" | "stop" | "bounce";

/** What a message in our thread means. */
export function classifyReply(from: string, snippet: string): ReplyKind {
  if (BOUNCE_FROM.test(from)) return "bounce";
  if (STOP_WORDS.test(snippet)) return "stop";
  return "reply";
}

/**
 * Looks at the Gmail threads the app started and records replies: they stop
 * the follow-ups and show up under "Replies waiting". Bounces and "please
 * unsubscribe" replies add the address to the do-not-contact list.
 */
export async function checkReplies(now = new Date(), everyMs = Number(process.env.REPLY_CHECK_MINUTES ?? 10) * 60_000): Promise<number> {
  const mail = mailFromEnv();
  if (!mail) return 0;
  const accounts = await db.gmailAccount.findMany({ where: { error: null, OR: [{ lastReplyCheckAt: null }, { lastReplyCheckAt: { lt: new Date(now.getTime() - everyMs) } }] } });
  let found = 0;
  for (const acc of accounts) {
    await db.gmailAccount.update({ where: { id: acc.id }, data: { lastReplyCheckAt: now } });
    const firsts = await db.outboundEmail.findMany({
      where: { restaurantId: acc.restaurantId, step: "FIRST", status: "SENT", gmailThreadId: { not: null }, draft: { stage: "CONTACTED" } },
      orderBy: { sentAt: "desc" },
      take: 50,
    });
    if (!firsts.length) continue;
    let token: string;
    try {
      token = (await accessTokenFor(acc.restaurantId)).token;
    } catch {
      continue;
    }
    const me = acc.email.toLowerCase();
    for (const first of firsts) {
      let messages;
      try {
        messages = await mail.thread(token, first.gmailThreadId!);
      } catch {
        continue;
      }
      const theirs = messages.filter((m) => !m.from.toLowerCase().includes(me) && m.date > (first.sentAt ?? first.scheduledFor));
      if (!theirs.length) continue;
      const latest = theirs[theirs.length - 1];
      const kind = classifyReply(latest.from, latest.snippet);
      if (kind === "bounce") {
        await suppress(acc.restaurantId, first.toEmail, "bounced");
      } else {
        await db.outboundEmail.updateMany({ where: { draftId: first.draftId, status: "SCHEDULED" }, data: { status: "CANCELLED", error: "They replied." } });
        await db.draft.update({
          where: { id: first.draftId },
          data: { stage: "REPLIED", stageUpdatedAt: now, repliedAt: latest.date, replySnippet: latest.snippet.slice(0, 500), replyHandled: false },
        });
        if (kind === "stop") await suppress(acc.restaurantId, first.toEmail, "replied-stop");
      }
      console.log(`[mail] ${kind} from ${first.toEmail}`);
      found++;
    }
  }
  return found;
}

let running = false;

/** One pass of the outreach work: send what's due, then look for replies. */
export async function runOutreach() {
  if (running) return;
  running = true;
  try {
    await sendDueEmails();
    await checkReplies();
  } catch (err) {
    console.error("[mail] outreach error:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}
