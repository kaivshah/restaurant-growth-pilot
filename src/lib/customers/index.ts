import { randomBytes } from "node:crypto";
import type { CustomerEmail, Draft, Restaurant } from "@prisma/client";
import { db } from "@/lib/db";
import { MailAccountError, MailRetryError, accessTokenFor, appUrl, mailFromEnv } from "@/lib/gmail";
import { buildRaw } from "@/lib/gmail/mime";
import { pacificDay } from "@/lib/llm/usage";
import { emailFooter, isSuppressed, unsubscribeToken } from "@/lib/outreach";
import { nextSendSlot } from "@/lib/outreach/schedule";
import { type Audience, WELCOME_DAYS, lastMoment, emailable, inAudience, isEmail, makeCode, normalizeCode, personalize, redeemState, validityDays } from "./codes";

export * from "./codes";

/**
 * The restaurant's own customer list:
 *
 *   QR at the counter ─▶ /join/<slug> (consent) ─▶ welcome code by email
 *   approved offer ─▶ "Send to customers" ─▶ one email per customer, each with a personal code
 *   counter ─▶ /redeem ─▶ code marked used ─▶ results per offer
 *
 * Customer emails go out any day 10 am–7 pm Pacific, about a minute apart,
 * capped per day, from the owner's Gmail, with an unsubscribe link.
 */

const DAY = 86_400_000;
const WINDOW = { startHour: 10, endHour: 19, spacingMin: 1, weekdaysOnly: false };

// ---------- Sign-up ----------

/** The public sign-up link's slug, made on first use: "subway-mira-mesa-k3f9". */
export async function ensureJoinSlug(restaurant: Pick<Restaurant, "id" | "name" | "joinSlug">): Promise<string> {
  if (restaurant.joinSlug) return restaurant.joinSlug;
  const base = restaurant.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "join";
  for (let i = 0; i < 5; i++) {
    const slug = `${base}-${randomBytes(3).toString("hex").slice(0, 4)}`;
    try {
      await db.restaurant.update({ where: { id: restaurant.id }, data: { joinSlug: slug } });
      return slug;
    } catch {
      // slug taken; try another
    }
  }
  throw new Error("Couldn't make a sign-up link.");
}

export const joinUrl = (slug: string) => `${appUrl()}/join/${slug}`;

/** The approved welcome offer, if the owner has approved one. */
export function welcomeOffer(restaurantId: string) {
  return db.draft.findFirst({ where: { restaurantId, kind: "CUSTOMER_OFFER", offerKey: "welcome", status: "APPROVED" }, orderBy: { decidedAt: "desc" } });
}

export type JoinResult = { ok: true; firstName: string | null; welcome: { title: string; code: string; validUntil: Date; emailed: boolean; existing: boolean } | null } | { ok: false; error: string };

/**
 * A customer joins the list (QR sign-up, or the owner adding someone who
 * agreed). Joining again after unsubscribing turns emails back on. If a
 * welcome offer is approved they get a code on screen and by email.
 */
export async function joinList(restaurantId: string, input: { email: string; firstName?: string; consent: boolean; source: "qr" | "owner" }, now = new Date()): Promise<JoinResult> {
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName?.trim().slice(0, 40) || null;
  if (!isEmail(email)) return { ok: false, error: "Enter a valid email address." };
  if (!input.consent) return { ok: false, error: input.source === "qr" ? "Tick the box to agree to get offers by email." : "Tick the box to confirm they agreed to get offers by email." };

  const customer = await db.customer.upsert({
    where: { restaurantId_email: { restaurantId, email } },
    create: { restaurantId, email, firstName, source: input.source, consentAt: now },
    update: { status: "ACTIVE", consentAt: now, ...(firstName ? { firstName } : {}) },
  });
  // Joining is a fresh "yes": lift an earlier unsubscribe.
  await db.suppression.deleteMany({ where: { restaurantId, email, reason: "unsubscribed" } });

  const offer = await welcomeOffer(restaurantId);
  if (!offer) return { ok: true, firstName: customer.firstName, welcome: null };
  const code = await issueCode(offer, customer.id, lastMoment(now, WELCOME_DAYS), now);
  if (!code) return { ok: true, firstName: customer.firstName, welcome: null };
  const gmail = await db.gmailAccount.findUnique({ where: { restaurantId } });
  if (gmail && !code.existing) {
    await db.customerEmail.upsert({
      where: { draftId_customerId: { draftId: offer.id, customerId: customer.id } },
      create: {
        restaurantId,
        draftId: offer.id,
        customerId: customer.id,
        toEmail: email,
        subject: offer.headline,
        body: personalize(offer.body, code.code, code.validUntil, customer.firstName),
        scheduledFor: now,
      },
      update: {},
    });
  }
  return { ok: true, firstName: customer.firstName, welcome: { title: offer.title, code: code.code, validUntil: code.validUntil, emailed: Boolean(gmail), existing: code.existing } };
}

/** One code per customer per offer; an existing one is returned as is. */
async function issueCode(draft: Pick<Draft, "id" | "restaurantId">, customerId: string, validUntil: Date, now: Date) {
  const existing = await db.offerCode.findUnique({ where: { draftId_customerId: { draftId: draft.id, customerId } } });
  if (existing) return { ...existing, existing: true };
  for (let i = 0; i < 3; i++) {
    try {
      const row = await db.offerCode.create({ data: { restaurantId: draft.restaurantId, draftId: draft.id, customerId, code: makeCode(), validFrom: now, validUntil } });
      return { ...row, existing: false };
    } catch {
      const raced = await db.offerCode.findUnique({ where: { draftId_customerId: { draftId: draft.id, customerId } } });
      if (raced) return { ...raced, existing: true };
    }
  }
  return null;
}

// ---------- Audiences ----------

async function activeCustomers(restaurantId: string, now: Date) {
  const [customers, suppressed] = await Promise.all([
    db.customer.findMany({
      where: { restaurantId, status: "ACTIVE" },
      select: { id: true, email: true, firstName: true, createdAt: true, codes: { where: { redeemedAt: { gte: new Date(now.getTime() - 60 * DAY) } }, select: { redeemedAt: true } } },
    }),
    db.suppression.findMany({ where: { restaurantId }, select: { email: true } }),
  ]);
  const blocked = new Set(suppressed.map((s) => s.email));
  return customers.filter((c) => !blocked.has(c.email)).map((c) => ({ ...c, redeemed: c.codes.map((x) => x.redeemedAt!) }));
}

export async function audienceCounts(restaurantId: string, now = new Date()): Promise<Record<Audience, number>> {
  const list = await activeCustomers(restaurantId, now);
  return {
    all: list.length,
    regulars: list.filter((c) => inAudience(c, "regulars", now)).length,
    lapsed: list.filter((c) => inAudience(c, "lapsed", now)).length,
  };
}

// ---------- Sending an offer to the list ----------

async function takenTimes(restaurantId: string, now: Date) {
  const rows = await db.customerEmail.findMany({
    where: { restaurantId, OR: [{ status: "SCHEDULED" }, { status: "SENT", sentAt: { gte: new Date(now.getTime() - DAY) } }] },
    select: { scheduledFor: true, sentAt: true },
  });
  return rows.map((r) => r.sentAt ?? r.scheduledFor);
}

export type SendResult = { ok: true; count: number; firstAt: Date | null; lastAt: Date | null } | { ok: false; reason: string };

/**
 * Gives everyone in the audience a personal code and schedules their email.
 * People who already got this offer are skipped, so it's safe to press twice.
 */
export async function sendOfferToCustomers(draftId: string, audience: Audience, now = new Date()): Promise<SendResult> {
  const draft = await db.draft.findUnique({ where: { id: draftId }, include: { restaurant: { include: { gmail: true } } } });
  if (!draft || draft.status !== "APPROVED") return { ok: false, reason: "Approve the offer first." };
  if (emailable(draft) !== "list") return { ok: false, reason: "This offer isn't sent by email." };
  const restaurant = draft.restaurant;
  if (!restaurant.gmail) return { ok: false, reason: "Connect Gmail in Email sending first." };

  const already = new Set((await db.customerEmail.findMany({ where: { draftId }, select: { customerId: true } })).map((e) => e.customerId));
  const people = (await activeCustomers(restaurant.id, now)).filter((c) => inAudience(c, audience, now) && !already.has(c.id));
  if (!people.length) return { ok: false, reason: already.size ? "Everyone in that group already has this offer." : "Nobody is in that group yet." };

  const days = validityDays(draft.facts);
  const taken = await takenTimes(restaurant.id, now);
  let after = new Date(now.getTime() + 60_000);
  const plan: { customer: (typeof people)[number]; at: Date; code: string }[] = [];
  for (const customer of people) {
    const at = nextSendSlot(after, taken, { ...WINDOW, dailyCap: restaurant.customerDailyCap });
    taken.push(at);
    after = at;
    plan.push({ customer, at, code: makeCode() });
  }

  await db.offerCode.createMany({
    data: plan.map((p) => ({ restaurantId: restaurant.id, draftId, customerId: p.customer.id, code: p.code, validFrom: now, validUntil: lastMoment(p.at, days) })),
    skipDuplicates: true,
  });
  const codes = new Map((await db.offerCode.findMany({ where: { draftId, customerId: { in: plan.map((p) => p.customer.id) } } })).map((c) => [c.customerId, c]));
  const emails = plan.flatMap((p) => {
    const code = codes.get(p.customer.id);
    if (!code) return [];
    return [{ restaurantId: restaurant.id, draftId, customerId: p.customer.id, toEmail: p.customer.email, subject: draft.headline, body: personalize(draft.body, code.code, code.validUntil, p.customer.firstName), scheduledFor: p.at }];
  });
  await db.customerEmail.createMany({ data: emails, skipDuplicates: true });
  await db.draft.update({ where: { id: draftId }, data: { sentAudience: audience, sentAt: draft.sentAt ?? now } });
  return { ok: true, count: emails.length, firstAt: emails[0]?.scheduledFor ?? null, lastAt: emails.at(-1)?.scheduledFor ?? null };
}

/** Undo: emails that haven't gone out yet are cancelled (their codes stop working). */
export async function cancelCustomerEmails(draftId: string, reason = "Stopped by you") {
  const pending = await db.customerEmail.findMany({ where: { draftId, status: "SCHEDULED" }, select: { customerId: true } });
  await db.customerEmail.updateMany({ where: { draftId, status: "SCHEDULED" }, data: { status: "CANCELLED", error: reason } });
  await db.offerCode.deleteMany({ where: { draftId, customerId: { in: pending.map((p) => p.customerId) }, redeemedAt: null } });
  return pending.length;
}

// ---------- Sending (worker) ----------

async function sentToday(restaurantId: string, now: Date) {
  const rows = await db.customerEmail.findMany({ where: { restaurantId, status: "SENT", sentAt: { gte: new Date(now.getTime() - DAY) } }, select: { sentAt: true } });
  return rows.filter((r) => r.sentAt && pacificDay(r.sentAt) === pacificDay(now)).length;
}

function claimDue(limit: number): Promise<CustomerEmail[]> {
  return db.$queryRaw<CustomerEmail[]>`
    UPDATE "CustomerEmail" SET status = 'SENDING', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "CustomerEmail" WHERE status = 'SCHEDULED' AND "scheduledFor" <= now()
      ORDER BY "scheduledFor" LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

const later = (id: string, ms: number, error: string) => db.customerEmail.update({ where: { id }, data: { status: "SCHEDULED", scheduledFor: new Date(Date.now() + ms), error } });
const cancel = (id: string, error: string) => db.customerEmail.update({ where: { id }, data: { status: "CANCELLED", error } });

/** Sends customer emails whose time has come. Safe to run from several workers at once. */
export async function sendDueCustomerEmails(limit = 20, now = new Date()): Promise<number> {
  const mail = mailFromEnv();
  const due = await claimDue(limit);
  let sent = 0;
  for (const email of due) {
    const [draft, customer] = await Promise.all([
      db.draft.findUnique({ where: { id: email.draftId }, include: { restaurant: { include: { outlets: true } } } }),
      db.customer.findUnique({ where: { id: email.customerId } }),
    ]);
    if (!draft || draft.status !== "APPROVED") {
      await cancel(email.id, "The offer was taken back.");
      continue;
    }
    const restaurant = draft.restaurant;
    if (!customer || customer.status !== "ACTIVE" || (await isSuppressed(restaurant.id, email.toEmail))) {
      await cancel(email.id, "Unsubscribed or bounced.");
      continue;
    }
    if (!mail) {
      await later(email.id, 3_600_000, "Gmail sending isn't configured (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).");
      continue;
    }
    if ((await sentToday(restaurant.id, now)) >= restaurant.customerDailyCap) {
      const next = nextSendSlot(new Date(now.getTime() + 60_000), await takenTimes(restaurant.id, now), { ...WINDOW, dailyCap: restaurant.customerDailyCap });
      await db.customerEmail.update({ where: { id: email.id }, data: { status: "SCHEDULED", scheduledFor: next, error: `Daily limit of ${restaurant.customerDailyCap} reached` } });
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
        unsubscribeUrl: `${appUrl()}/api/unsubscribe/${unsubscribeToken(restaurant.id, email.toEmail)}`,
        unsubscribeMailto: from,
      });
      const res = await mail.send(token, raw, null);
      await db.customerEmail.update({ where: { id: email.id }, data: { status: "SENT", sentAt: new Date(), gmailMessageId: res.id, error: null } });
      console.log(`[mail] sent offer "${draft.title}" to customer ${email.toEmail}`);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[mail] couldn't send to customer ${email.toEmail}: ${message}`);
      if (err instanceof MailAccountError) await later(email.id, 3_600_000, message);
      else if (err instanceof MailRetryError) await later(email.id, 10 * 60_000, message);
      else if (email.attempts >= 3) await db.customerEmail.update({ where: { id: email.id }, data: { status: "FAILED", error: message } });
      else await later(email.id, 15 * 60_000, message);
    }
  }
  return sent;
}

// ---------- At the counter ----------

export type CodeCheck =
  | { state: "invalid" | "not-found"; code: string }
  | { state: "ok" | "used" | "expired" | "not-yet"; code: string; offer: string; firstName: string | null; validUntil: Date; redeemedAt: Date | null };

/** Looks a code up without using it. */
export async function checkCode(restaurantId: string, input: string, now = new Date()): Promise<CodeCheck> {
  const code = normalizeCode(input);
  if (!code) return { state: "invalid", code: input.trim().toUpperCase() };
  const row = await db.offerCode.findFirst({ where: { restaurantId, code }, include: { draft: { select: { title: true } }, customer: { select: { firstName: true } } } });
  const state = redeemState(row, now);
  if (!row || state === "not-found" || state === "invalid") return { state: "not-found", code };
  return { state, code, offer: row.draft.title, firstName: row.customer.firstName, validUntil: row.validUntil, redeemedAt: row.redeemedAt };
}

/** Marks a code used, once. Two tills pressing at the same moment can't both succeed. */
export async function redeemCode(restaurantId: string, input: string, now = new Date()): Promise<CodeCheck> {
  const check = await checkCode(restaurantId, input, now);
  if (check.state !== "ok") return check;
  const res = await db.offerCode.updateMany({ where: { restaurantId, code: check.code, redeemedAt: null }, data: { redeemedAt: now } });
  if (!res.count) return checkCode(restaurantId, input, now);
  return { ...check, redeemedAt: now };
}

// ---------- Results ----------

export interface OfferResult {
  draftId: string;
  title: string;
  audience: string | null;
  sentAt: Date | null;
  scheduled: number;
  sent: number;
  failed: number;
  codes: number;
  redeemed: number;
  /** Share of codes used, in whole percent */
  rate: number | null;
}

export async function offerResults(restaurantId: string, draftIds?: string[]): Promise<OfferResult[]> {
  const drafts = await db.draft.findMany({
    where: { restaurantId, kind: "CUSTOMER_OFFER", ...(draftIds ? { id: { in: draftIds } } : {}), OR: [{ sentAt: { not: null } }, { codes: { some: {} } }] },
    select: { id: true, title: true, sentAudience: true, sentAt: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!drafts.length) return [];
  const ids = drafts.map((d) => d.id);
  const [emails, codes, used] = await Promise.all([
    db.customerEmail.groupBy({ by: ["draftId", "status"], where: { draftId: { in: ids } }, _count: { _all: true } }),
    db.offerCode.groupBy({ by: ["draftId"], where: { draftId: { in: ids } }, _count: { _all: true } }),
    db.offerCode.groupBy({ by: ["draftId"], where: { draftId: { in: ids }, redeemedAt: { not: null } }, _count: { _all: true } }),
  ]);
  const count = (id: string, status: string) => emails.find((e) => e.draftId === id && e.status === status)?._count._all ?? 0;
  return drafts.map((d) => {
    const issued = codes.find((c) => c.draftId === d.id)?._count._all ?? 0;
    const redeemed = used.find((c) => c.draftId === d.id)?._count._all ?? 0;
    return {
      draftId: d.id,
      title: d.title,
      audience: d.sentAudience,
      sentAt: d.sentAt,
      scheduled: count(d.id, "SCHEDULED") + count(d.id, "SENDING"),
      sent: count(d.id, "SENT"),
      failed: count(d.id, "FAILED"),
      codes: issued,
      redeemed,
      rate: issued ? Math.round((redeemed / issued) * 100) : null,
    };
  });
}
