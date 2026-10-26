/** Builds a plain-text email (RFC 5322) for the Gmail API's `raw` field. */

export interface OutgoingMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Message-ID of the email this one follows up, so it threads in the inbox */
  inReplyTo?: string;
  /** One-click unsubscribe (RFC 8058): a URL that accepts POST, and a mailto */
  unsubscribeUrl?: string;
  unsubscribeMailto?: string;
}

/** Non-ASCII subjects are encoded as RFC 2047 UTF-8 words. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

const address = (v: string) => v.replace(/[\r\n<>]/g, "").trim();

export function buildRaw(m: OutgoingMessage): string {
  const headers = [
    `From: ${address(m.from)}`,
    `To: ${address(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`);
  const unsub = [m.unsubscribeUrl && `<${m.unsubscribeUrl}>`, m.unsubscribeMailto && `<mailto:${m.unsubscribeMailto}?subject=unsubscribe>`].filter(Boolean);
  if (unsub.length) headers.push(`List-Unsubscribe: ${unsub.join(", ")}`);
  if (m.unsubscribeUrl) headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}
