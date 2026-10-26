import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encryption for secrets at rest (Gmail tokens) and signed links
 * (unsubscribe). Keys come from AUTH_SECRET, which Auth.js already requires.
 */

function key(purpose: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set.");
  return createHash("sha256").update(`${purpose}:${secret ?? "dev-only-secret"}`).digest();
}

/** AES-256-GCM: "v1.<iv>.<tag>.<data>" in base64url. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("encrypt"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unreadable secret.");
  const decipher = createDecipheriv("aes-256-gcm", key("encrypt"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** A signed, URL-safe token carrying a small payload. */
export function signToken(payload: string): string {
  const body = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", key("sign")).update(body).digest("base64url").slice(0, 22);
  return `${body}.${sig}`;
}

export function verifyToken(token: string): string | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", key("sign")).update(body).digest("base64url").slice(0, 22);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}
