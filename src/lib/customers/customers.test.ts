import { describe, expect, it } from "vitest";
import { nextSendSlot, pacificParts } from "@/lib/outreach/schedule";
import { CODE_ALPHABET, emailable, inAudience, isEmail, lastMoment, makeCode, normalizeCode, personalize, redeemState, validityDays } from "./codes";

const DAY = 86_400_000;

describe("codes", () => {
  it("makes XXXX-XXXX codes without look-alike characters", () => {
    for (let i = 0; i < 200; i++) {
      const c = makeCode();
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c).not.toMatch(/[01OI]/);
    }
    expect(CODE_ALPHABET).toHaveLength(32);
  });

  it("reads codes the way staff type them", () => {
    expect(normalizeCode("k7qm 4tz9")).toBe("K7QM-4TZ9");
    expect(normalizeCode("K7QM4TZ9")).toBe("K7QM-4TZ9");
    expect(normalizeCode(" k7qm-4tz9 ")).toBe("K7QM-4TZ9");
    expect(normalizeCode("K7QM-4TZ")).toBeNull();
    expect(normalizeCode("K7QM-4TZ0")).toBeNull(); // 0 is never used
  });

  it("ends at 11:59 pm Pacific on the last day, across the clock change", () => {
    const end = pacificParts(lastMoment(new Date("2026-10-26T17:00:00Z"), 28)); // Mon 10 am PDT + 4 weeks
    expect([end.m, end.d, end.h, end.mi]).toEqual([11, 23, 23, 59]);
  });

  it("knows when a code works", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    const code = { validFrom: new Date(now.getTime() - DAY), validUntil: new Date(now.getTime() + DAY), redeemedAt: null };
    expect(redeemState(code, now)).toBe("ok");
    expect(redeemState({ ...code, redeemedAt: now }, now)).toBe("used");
    expect(redeemState(code, new Date(now.getTime() + 2 * DAY))).toBe("expired");
    expect(redeemState(code, new Date(now.getTime() - 2 * DAY))).toBe("not-yet");
    expect(redeemState(null, now)).toBe("not-found");
  });
});

describe("offer details", () => {
  it("reads how long an offer lasts", () => {
    expect(validityDays(["Free chips", "Valid for 2 weeks"])).toBe(14);
    expect(validityDays(["Valid for 1 week"])).toBe(7);
    expect(validityDays(["Valid for 10 days"])).toBe(10);
    expect(validityDays(["Free cookie"])).toBe(14);
  });

  it("puts each customer's code and name in the email", () => {
    const until = new Date("2026-11-16T20:00:00Z");
    const withSlot = personalize("Show [CODE] at the counter for free chips.", "K7QM-4TZ9", until, "Maya");
    expect(withSlot.startsWith("Hi Maya,\n\n")).toBe(true);
    expect(withSlot).toContain("Show K7QM-4TZ9 at the counter");
    expect(withSlot).toContain("Valid until Mon, Nov 16.");
    expect(withSlot).not.toContain("[CODE]");

    const noSlot = personalize("Hello there! Free cookie for joining.", "AB23-CD45", until, "Maya");
    expect(noSlot.startsWith("Hello there!")).toBe(true); // no second greeting
    expect(noSlot).toContain("Your code: AB23-CD45");
    expect(personalize("Free chips.", "AB23-CD45", until)).not.toContain("Hi ");
  });

  it("emails only offers that carry a code; welcome goes out on sign-up", () => {
    expect(emailable({ kind: "CUSTOMER_OFFER", offerKey: "welcome", needsCode: false })).toBe("welcome");
    expect(emailable({ kind: "CUSTOMER_OFFER", offerKey: "afternoon-drink", needsCode: true })).toBe("list");
    expect(emailable({ kind: "CUSTOMER_OFFER", offerKey: "ai-counter-card", needsCode: false })).toBeNull();
    expect(emailable({ kind: "CATERING_PITCH", offerKey: "x", needsCode: true })).toBeNull();
  });

  it("checks email addresses", () => {
    expect(isEmail("maya@example.com")).toBe(true);
    expect(isEmail("maya@example")).toBe(false);
    expect(isEmail("not an email")).toBe(false);
  });
});

describe("audiences", () => {
  const now = new Date("2026-11-02T20:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  it("finds regulars and people who haven't been back", () => {
    const regular = { createdAt: ago(90), redeemed: [ago(5), ago(20), ago(50)] };
    const oldVisits = { createdAt: ago(90), redeemed: [ago(40), ago(45), ago(70)] };
    const brandNew = { createdAt: ago(3), redeemed: [] };
    expect(inAudience(regular, "regulars", now)).toBe(true);
    expect(inAudience(oldVisits, "regulars", now)).toBe(false);
    expect(inAudience(regular, "lapsed", now)).toBe(false);
    expect(inAudience(oldVisits, "lapsed", now)).toBe(true);
    expect(inAudience(brandNew, "lapsed", now)).toBe(false); // too new to have lapsed
    expect(inAudience(brandNew, "all", now)).toBe(true);
  });
});

describe("customer send times", () => {
  it("can send on weekends, 10 am to 7 pm, a minute apart", () => {
    const saturday = new Date("2026-10-31T15:00:00Z"); // Sat 8:00 PT
    const opts = { startHour: 10, endHour: 19, spacingMin: 1, weekdaysOnly: false, dailyCap: 3, random: () => 0 };
    const taken: Date[] = [];
    for (let i = 0; i < 4; i++) taken.push(nextSendSlot(saturday, taken, opts));
    const parts = taken.map(pacificParts);
    expect(parts.slice(0, 3).map((p) => [p.weekday, p.h, p.mi])).toEqual([
      [6, 10, 0],
      [6, 10, 1],
      [6, 10, 2],
    ]);
    expect(parts[3].weekday).toBe(0); // the cap pushes the 4th to Sunday
    // Pitches still skip the weekend.
    expect(pacificParts(nextSendSlot(saturday, [], { random: () => 0 })).weekday).toBe(1);
  });
});
