import { describe, expect, it } from "vitest";
import { decrypt, encrypt, signToken, verifyToken } from "@/lib/crypto";
import { fromThreadMessages } from "@/lib/gmail";
import { buildRaw, encodeHeader } from "@/lib/gmail/mime";
import { classifyReply, emailFooter, readUnsubscribeToken, unsubscribeToken } from "./index";
import { fromPacific, nextSendSlot, pacificParts } from "./schedule";

const noJitter = { random: () => 0 };

describe("send slots", () => {
  it("waits for the next weekday morning in San Diego", () => {
    // Saturday Oct 24, 2026, 3 pm Pacific → Monday Oct 26, 9:00 am
    const slot = nextSendSlot(fromPacific(2026, 10, 24, 15), [], noJitter);
    expect(pacificParts(slot)).toMatchObject({ y: 2026, m: 10, d: 26, h: 9, mi: 0, weekday: 1 });
  });

  it("sends inside the window the same day when there's time", () => {
    const slot = nextSendSlot(fromPacific(2026, 10, 27, 9, 30), [], noJitter);
    expect(pacificParts(slot)).toMatchObject({ d: 27, h: 9, mi: 30 });
    const late = nextSendSlot(fromPacific(2026, 10, 27, 14), [], noJitter);
    expect(pacificParts(late)).toMatchObject({ d: 28, h: 9 });
  });

  it("spaces emails a few minutes apart and respects the daily cap", () => {
    const start = fromPacific(2026, 10, 27, 9);
    const taken = [start];
    const second = nextSendSlot(start, taken, noJitter);
    expect((second.getTime() - start.getTime()) / 60_000).toBeGreaterThanOrEqual(4);
    const full = Array.from({ length: 3 }, (_, i) => new Date(start.getTime() + i * 5 * 60_000));
    expect(pacificParts(nextSendSlot(start, full, { ...noJitter, dailyCap: 3 }))).toMatchObject({ d: 28, h: 9 });
  });

  it("handles the switch from daylight saving time", () => {
    // Nov 2, 2026 is a Monday after DST ends (Nov 1): 9 am PST is 17:00 UTC
    expect(fromPacific(2026, 11, 2, 9).toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(fromPacific(2026, 10, 27, 9).toISOString()).toBe("2026-10-27T16:00:00.000Z");
  });
});

describe("email format", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

  it("builds a plain-text email with threading and one-click unsubscribe", () => {
    const text = decode(
      buildRaw({
        from: "Subway #00000 <owner@example.com>",
        to: "jo@acme.example",
        subject: "Re: Team lunch?",
        body: "Hi Jo,\nJust checking in.",
        inReplyTo: "<abc@mail.gmail.com>",
        unsubscribeUrl: "https://app.example/api/unsubscribe/t",
        unsubscribeMailto: "owner@example.com",
      }),
    );
    expect(text).toContain("To: jo@acme.example");
    expect(text).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(text).toContain("List-Unsubscribe: <https://app.example/api/unsubscribe/t>, <mailto:owner@example.com?subject=unsubscribe>");
    expect(text).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const body = text.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hi Jo,\r\nJust checking in.");
  });

  it("encodes non-English subjects and strips header injection", () => {
    expect(encodeHeader("Almuerzo para el equipo — ¿sí?")).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeader("Hello\r\nBcc: evil@x.com")).toBe("Hello Bcc: evil@x.com");
    expect(decode(buildRaw({ from: "a@b.c", to: "x@y.z\r\nBcc: evil@x.com", subject: "s", body: "b" }))).not.toMatch(/\r\nBcc:/);
  });
});

describe("secrets and links", () => {
  it("encrypts tokens at rest", () => {
    const sealed = encrypt("1//refresh-token");
    expect(sealed).not.toContain("refresh");
    expect(decrypt(sealed)).toBe("1//refresh-token");
    expect(() => decrypt(sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toThrow();
  });

  it("signs unsubscribe links so they can't be forged", () => {
    const token = unsubscribeToken("rest_1", "Jo@Acme.example");
    expect(readUnsubscribeToken(token)).toEqual({ restaurantId: "rest_1", email: "jo@acme.example" });
    expect(readUnsubscribeToken(signToken("rest_2|x@y.z").replace(/.$/, "x"))).toBeNull();
    expect(verifyToken("garbage")).toBeNull();
  });

  it("adds the address, franchise line and unsubscribe link to every email", () => {
    const footer = emailFooter({ id: "r1", name: "Subway #00000", kind: "FRANCHISE" }, "1915 El Cajon Blvd, San Diego, CA", "jo@acme.example", "Hi Jo");
    expect(footer).toContain("1915 El Cajon Blvd");
    expect(footer).toContain("independently owned and operated");
    expect(footer).toMatch(/Unsubscribe: http.*\/u\//);
    expect(emailFooter({ id: "r1", name: "S", kind: "FRANCHISE" }, "", "a@b.c", "S is independently owned and operated.")).not.toContain("S is independently owned and operated.");
  });
});

describe("replies", () => {
  it("tells replies, stop requests and bounces apart", () => {
    expect(classifyReply("Jo Park <jo@acme.example>", "Sounds great, can you send a menu?")).toBe("reply");
    expect(classifyReply("Jo Park <jo@acme.example>", "Please remove me from your list")).toBe("stop");
    expect(classifyReply("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Address not found")).toBe("bounce");
  });

  it("reads Gmail thread messages", () => {
    const [m] = fromThreadMessages([{ id: "1", threadId: "t", internalDate: "1793000000000", snippet: "Hi!", payload: { headers: [{ name: "From", value: "Jo <jo@acme.example>" }] } }]);
    expect(m).toMatchObject({ id: "1", from: "Jo <jo@acme.example>", snippet: "Hi!" });
    expect(m.date.getTime()).toBe(1793000000000);
  });
});
