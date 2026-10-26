import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

/**
 * Sending from, and reading replies in, the owner's own Gmail through the
 * Gmail API. OAuth uses the same Google client as sign-in (AUTH_GOOGLE_ID /
 * AUTH_GOOGLE_SECRET) with an extra redirect URI: <APP_URL>/api/gmail/callback.
 * GMAIL_PROVIDER="fake" keeps everything local for testing.
 */

export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

/** Gmail access is gone or misconfigured; sending pauses until the owner reconnects. */
export class MailAccountError extends Error {}
/** A temporary problem (rate limit, Google down); try again later. */
export class MailRetryError extends Error {}

export interface ThreadMessage {
  id: string;
  from: string;
  date: Date;
  snippet: string;
}

export interface MailProvider {
  name: "gmail" | "fake";
  send(accessToken: string, raw: string, threadId?: string | null): Promise<{ id: string; threadId: string; rfcMessageId: string | null }>;
  thread(accessToken: string, threadId: string): Promise<ThreadMessage[]>;
}

export function mailFromEnv(env: NodeJS.ProcessEnv = process.env): MailProvider | null {
  if ((env.GMAIL_PROVIDER ?? "").toLowerCase() === "fake" && env.NODE_ENV !== "production") return fakeMail;
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) return gmail;
  return null;
}

// ---------- OAuth ----------

export function oauthUrl(state: string) {
  const q = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    redirect_uri: `${appUrl()}/api/gmail/callback`,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.AUTH_GOOGLE_ID ?? "", client_secret: process.env.AUTH_GOOGLE_SECRET ?? "", ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok) {
    if (body.error === "invalid_grant") throw new MailAccountError("Gmail access was revoked or expired. Reconnect Gmail in Email settings.");
    if (res.status >= 500 || res.status === 429) throw new MailRetryError(`Google sign-in is unavailable (${res.status}).`);
    throw new MailAccountError(`Google refused the Gmail connection: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body;
}

/** After the owner approves access: store the account with its tokens encrypted. */
export async function connectWithCode(restaurantId: string, code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: `${appUrl()}/api/gmail/callback` });
  if (!t.access_token || !t.refresh_token) throw new MailAccountError("Google didn't return offline access. Try connecting again.");
  const granted = (t.scope ?? "").split(" ");
  const missing = GMAIL_SCOPES.filter((s) => s.startsWith("https://") && !granted.includes(s));
  if (missing.length) throw new MailAccountError("Please tick both Gmail boxes (send email, and read replies) on Google's screen.");
  const profile = await gmailFetch(t.access_token, "profile");
  const email = String((profile as { emailAddress?: string }).emailAddress ?? "");
  return saveAccount(restaurantId, email, t.refresh_token, t.access_token, t.expires_in ?? 3600, t.scope ?? GMAIL_SCOPES.join(" "));
}

async function saveAccount(restaurantId: string, email: string, refreshToken: string, accessToken: string, expiresIn: number, scopes: string) {
  const data = {
    email,
    refreshToken: encrypt(refreshToken),
    accessToken: encrypt(accessToken),
    accessTokenExpiresAt: new Date(Date.now() + (expiresIn - 60) * 1000),
    scopes,
    error: null,
    connectedAt: new Date(),
  };
  return db.gmailAccount.upsert({ where: { restaurantId }, create: { restaurantId, ...data }, update: data });
}

/** A usable access token for the restaurant's Gmail, refreshed when needed. */
export async function accessTokenFor(restaurantId: string): Promise<{ email: string; token: string }> {
  const acc = await db.gmailAccount.findUnique({ where: { restaurantId } });
  if (!acc) throw new MailAccountError("Gmail isn't connected.");
  if (mailFromEnv()?.name === "fake") return { email: acc.email, token: "fake" };
  if (acc.accessToken && acc.accessTokenExpiresAt && acc.accessTokenExpiresAt > new Date()) return { email: acc.email, token: decrypt(acc.accessToken) };
  try {
    const t = await tokenRequest({ refresh_token: decrypt(acc.refreshToken), grant_type: "refresh_token" });
    await db.gmailAccount.update({
      where: { restaurantId },
      data: { accessToken: encrypt(t.access_token!), accessTokenExpiresAt: new Date(Date.now() + ((t.expires_in ?? 3600) - 60) * 1000), error: null },
    });
    return { email: acc.email, token: t.access_token! };
  } catch (err) {
    if (err instanceof MailAccountError) await db.gmailAccount.update({ where: { restaurantId }, data: { error: err.message } });
    throw err;
  }
}

export async function disconnect(restaurantId: string) {
  const acc = await db.gmailAccount.findUnique({ where: { restaurantId } });
  if (!acc) return;
  if (mailFromEnv()?.name === "gmail") {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(acc.refreshToken))}`, { method: "POST" }).catch(() => {});
  }
  await db.gmailAccount.delete({ where: { restaurantId } });
}

// ---------- Gmail API ----------

async function gmailFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new MailAccountError(`Gmail refused access: ${message}`);
  if (res.status === 429 || res.status >= 500) throw new MailRetryError(`Gmail is busy (${res.status}): ${message}`);
  throw new Error(`Gmail error ${res.status}: ${message}`);
}

type GmailMessage = { id: string; threadId: string; internalDate?: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export function fromThreadMessages(messages: GmailMessage[]): ThreadMessage[] {
  return messages.map((m) => ({ id: m.id, from: header(m, "From"), date: new Date(Number(m.internalDate ?? 0)), snippet: m.snippet ?? "" }));
}

export const gmail: MailProvider = {
  name: "gmail",
  async send(token, raw, threadId) {
    const sent = (await gmailFetch(token, "messages/send", { method: "POST", body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) })) as GmailMessage;
    const meta = (await gmailFetch(token, `messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`).catch(() => null)) as GmailMessage | null;
    return { id: sent.id, threadId: sent.threadId, rfcMessageId: meta ? header(meta, "Message-ID") || null : null };
  },
  async thread(token, threadId) {
    const t = (await gmailFetch(token, `threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date`)) as { messages?: GmailMessage[] };
    return fromThreadMessages(t.messages ?? []);
  },
};

// ---------- Fake (GMAIL_PROVIDER=fake): a local mailbox in the database ----------

type FakeThread = ThreadMessage[];
const fakeKey = (threadId: string) => `fake-mail:${threadId}`;
const far = () => new Date(Date.now() + 365 * 86_400_000);

async function fakeThread(threadId: string): Promise<FakeThread> {
  const row = await db.cacheEntry.findUnique({ where: { key: fakeKey(threadId) } });
  return ((row?.value as unknown as (ThreadMessage & { date: string })[]) ?? []).map((m) => ({ ...m, date: new Date(m.date) }));
}
async function saveFakeThread(threadId: string, messages: FakeThread) {
  const value = JSON.parse(JSON.stringify(messages));
  await db.cacheEntry.upsert({ where: { key: fakeKey(threadId) }, create: { key: fakeKey(threadId), value, expiresAt: far() }, update: { value, expiresAt: far() } });
}

export const fakeMail: MailProvider = {
  name: "fake",
  async send(_token, raw, threadId) {
    const id = `fake-${randomUUID().slice(0, 8)}`;
    const thread = threadId ?? `thread-${id}`;
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const from = text.match(/^From: (.*)$/m)?.[1] ?? "owner@example.com";
    await saveFakeThread(thread, [...(await fakeThread(thread)), { id, from, date: new Date(), snippet: "(sent)" }]);
    console.log(`[mail] (fake) sent ${id} in ${thread} to ${text.match(/^To: (.*)$/m)?.[1]}`);
    return { id, threadId: thread, rfcMessageId: `<${id}@fake.local>` };
  },
  async thread(_token, threadId) {
    return fakeThread(threadId);
  },
};

/** Development only: pretend the business replied in a fake thread. */
export async function simulateFakeReply(threadId: string, from: string, text: string) {
  await saveFakeThread(threadId, [...(await fakeThread(threadId)), { id: `fake-reply-${randomUUID().slice(0, 6)}`, from, date: new Date(), snippet: text }]);
}

/** Development only: connect a pretend Gmail account. */
export async function connectFake(restaurantId: string, email = "owner@example.com") {
  return saveAccount(restaurantId, email, "fake-refresh", "fake-access", 3600 * 24 * 365, GMAIL_SCOPES.join(" "));
}
