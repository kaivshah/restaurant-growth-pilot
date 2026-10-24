import { describe, expect, it } from "vitest";
import { fakeLeadAnalyst } from "@/lib/analyst/leads/fake";
import { type LeadContext, type Pitch, checkPitch, defaultPitches, runLeadAnalysis } from "@/lib/analyst/leads";
import type { ToolLog } from "@/lib/analyst/verify";
import { fromHunterDomainSearch, rankContacts } from "@/lib/contacts";
import { type LocalEvent, fromPredictHq, fromTicketmaster } from "@/lib/events";
import { domainOf, isUsefulDomain, milesBetween } from "@/lib/geo";
import { validateCopy } from "@/lib/llm";
import { type Place, fromGooglePlace } from "@/lib/places";
import { scoreEvent, scoreLead } from "./score";

const place = (over: Partial<Place> = {}): Place => ({
  placeId: "p1",
  name: "Northwind Labs",
  category: "office",
  types: ["corporate_office"],
  address: "1 Test St",
  location: { lat: 32.96, lng: -117.14 },
  website: "https://northwind.example",
  phone: null,
  ratingCount: 40,
  businessStatus: "OPERATIONAL",
  ...over,
});

describe("geo", () => {
  it("measures miles between points", () => {
    // Downtown San Diego to Mira Mesa is roughly 12–13 miles in a straight line.
    const d = milesBetween({ lat: 32.7157, lng: -117.1611 }, { lat: 32.9157, lng: -117.1436 });
    expect(d).toBeGreaterThan(13);
    expect(d).toBeLessThan(14.5);
    expect(milesBetween({ lat: 32.9, lng: -117.1 }, { lat: 32.9, lng: -117.1 })).toBe(0);
  });

  it("finds a business's own domain and ignores platforms", () => {
    expect(domainOf("https://www.Northwind.com/about")).toBe("northwind.com");
    expect(domainOf("northwind.com")).toBe("northwind.com");
    expect(domainOf(null)).toBeNull();
    expect(isUsefulDomain("northwind.com")).toBe(true);
    expect(isUsefulDomain("facebook.com")).toBe(false);
    expect(isUsefulDomain("shop.wixsite.com")).toBe(false);
  });
});

describe("lead scoring", () => {
  it("excludes closed places and places outside the radius", () => {
    expect(scoreLead(place({ businessStatus: "CLOSED_PERMANENTLY" }), 1, 3).excluded).toBe("Permanently closed");
    expect(scoreLead(place(), 3.4, 3).excluded).toBe("Outside the delivery radius");
  });

  it("prefers closer offices with a website", () => {
    const near = scoreLead(place(), 0.5, 3);
    const far = scoreLead(place(), 2.8, 3);
    const noSite = scoreLead(place({ website: null }), 0.5, 3);
    const gym = scoreLead(place({ category: "gym" }), 0.5, 3);
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.score).toBeGreaterThan(noSite.score);
    expect(near.score).toBeGreaterThan(gym.score);
    expect(near.reasons[0]).toBe("Office · 0.5 mi away");
  });
});

describe("event scoring", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const ev = (days: number, over: Partial<LocalEvent> = {}): LocalEvent => ({
    source: "test",
    externalId: "e1",
    title: "Biotech Summit",
    category: "conference",
    startsAt: new Date(now.getTime() + days * 86_400_000),
    endsAt: null,
    venueName: "Hall",
    venueAddress: null,
    location: null,
    attendance: 1200,
    organizer: null,
    url: null,
    ...over,
  });

  it("only keeps events 7–60 days ahead and inside the radius", () => {
    expect(scoreEvent(ev(3), 1, 3, now).excluded).toBe("Too soon");
    expect(scoreEvent(ev(75), 1, 3, now).excluded).toBe("Too far ahead");
    expect(scoreEvent(ev(21), 5, 3, now).excluded).toBe("Outside the delivery radius");
    expect(scoreEvent(ev(21), 1, 3, now).excluded).toBeNull();
  });

  it("scores conferences 2–6 weeks out with big crowds highest", () => {
    const best = scoreEvent(ev(21), 1, 3, now).score;
    expect(best).toBeGreaterThan(scoreEvent(ev(55), 1, 3, now).score);
    expect(best).toBeGreaterThan(scoreEvent(ev(21, { category: "concert" }), 1, 3, now).score);
    expect(best).toBeGreaterThan(scoreEvent(ev(21, { attendance: 50 }), 1, 3, now).score);
    expect(scoreEvent(ev(21), 1, 3, now).reasons).toContain("About 1,200 expected");
  });
});

describe("provider response parsing", () => {
  it("reads a Google Places (New) result", () => {
    const p = fromGooglePlace(
      {
        id: "ChIJ123",
        displayName: { text: "Acme Corp" },
        formattedAddress: "10 Main St, San Diego, CA",
        location: { latitude: 32.9, longitude: -117.1 },
        types: ["corporate_office"],
        websiteUri: "https://acme.example",
        businessStatus: "OPERATIONAL",
        userRatingCount: 12,
      },
      "office",
    );
    expect(p).toMatchObject({ placeId: "ChIJ123", name: "Acme Corp", location: { lat: 32.9, lng: -117.1 }, website: "https://acme.example", ratingCount: 12 });
    expect(fromGooglePlace({ id: "x" }, "office")).toBeNull();
  });

  it("reads Hunter domain search and ranks food-ordering roles first", () => {
    const found = fromHunterDomainSearch({
      data: {
        emails: [
          { value: "CEO@acme.example", confidence: 99, first_name: "Sam", last_name: "Lee", position: "CEO" },
          { value: "jo@acme.example", confidence: 80, first_name: "Jo", last_name: null, position: "Office Manager" },
          { value: "", confidence: 50 },
        ],
      },
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ name: "Sam Lee", role: "CEO", email: "ceo@acme.example", confidence: 99 });
    expect(rankContacts(found)[0].email).toBe("jo@acme.example");
  });

  it("reads PredictHQ events with venue and attendance", () => {
    const [e] = fromPredictHq({
      results: [
        {
          id: "phq1",
          title: "Biotech Summit",
          category: "conferences",
          start: "2026-11-14T16:00:00Z",
          phq_attendance: 1200,
          location: [-117.1, 32.9],
          entities: [{ type: "venue", name: "Convention Hall", formatted_address: "1 Hall Way" }],
        },
      ],
    });
    expect(e).toMatchObject({ source: "predicthq", category: "conference", attendance: 1200, venueName: "Convention Hall", location: { lat: 32.9, lng: -117.1 } });
  });

  it("reads Ticketmaster events", () => {
    const [e] = fromTicketmaster({
      _embedded: {
        events: [
          {
            id: "tm1",
            name: "Padres vs. Dodgers",
            url: "https://tm.example/e",
            dates: { start: { localDate: "2026-11-20" } },
            classifications: [{ segment: { name: "Sports" } }],
            _embedded: { venues: [{ name: "Petco Park", location: { latitude: "32.70", longitude: "-117.15" } }] },
          },
        ],
      },
    });
    expect(e).toMatchObject({ category: "sports", venueName: "Petco Park", location: { lat: 32.7, lng: -117.15 }, attendance: null });
  });
});

function leadCtx(over: { rules?: Partial<LeadContext["rules"]>; status?: LeadContext["leads"][number]["status"] } = {}): LeadContext {
  return {
    restaurant: { name: "Subway #00000", kind: "FRANCHISE", brand: "Subway", radiusMiles: 3, minCateringOrder: 10, openingHours: null },
    rules: {
      promoApproval: "UNSURE",
      maxDiscountPct: 15,
      allowFreeExtra: true,
      allowFreeDelivery: true,
      allowPercentOff: true,
      allowBogo: false,
      useBrandCateringMenu: true,
      ...over.rules,
    },
    reports: [],
    pastDecisions: [],
    leads: [
      {
        id: "L1",
        name: "Northwind Labs",
        category: "office",
        distanceMiles: 0.8,
        fitScore: 78,
        reasons: ["Office · 0.8 mi away"],
        status: over.status ?? "NEW",
        excludeReason: over.status === "EXCLUDED" ? "Too far" : null,
        contacts: [{ id: "C1", name: "Jo Park", role: "Office Manager", verification: "valid" }],
      },
      { id: "L2", name: "Black Mountain Event Hall", category: "venue", distanceMiles: 1.7, fitScore: 60, reasons: ["Event venue · 1.7 mi away"], status: "NEW", excludeReason: null, contacts: [] },
      { id: "L3", name: "Summit Fitness", category: "gym", distanceMiles: 2.5, fitScore: 30, reasons: ["Gym · 2.5 mi away"], status: "NEW", excludeReason: null, contacts: [] },
    ],
    events: [
      { id: "E1", title: "Biotech Summit", category: "conference", date: "2026-11-14", daysAhead: 21, venueName: "Black Mountain Event Hall", venueLeadId: "L2", attendance: 1200, distanceMiles: 1.7, fitScore: 80, reasons: [] },
      { id: "E2", title: "Market", category: "community", date: "2026-10-27", daysAhead: 3, venueName: null, venueLeadId: null, attendance: 400, distanceMiles: 0.2, fitScore: 30, reasons: [] },
    ],
  };
}

const log: ToolLog = [{ id: "t1", name: "list_leads", input: {}, output: { leads: [{ lead_id: "L1", fit_score: 78, distance_miles: 0.8 }] } }];
const pitch = (over: Partial<Pitch> = {}): Pitch => ({
  lead_id: "L1",
  contact_id: "C1",
  offer: "free_cookie_platter",
  occasion: "Weekly team lunches",
  why: "Close by, with an office manager we can reach.",
  confidence: "high",
  evidence: [{ tool_call_id: "t1", field: "leads[0].fit_score", value: 78, label: "Fit score" }],
  ...over,
});

describe("lead analyst checks", () => {
  it("accepts a valid pitch", () => {
    expect(checkPitch(pitch(), leadCtx(), log)).toEqual([]);
  });

  it("rejects unknown leads, excluded leads and contacts from another lead", () => {
    expect(checkPitch(pitch({ lead_id: "nope" }), leadCtx(), log)[0]).toMatch(/no lead/);
    expect(checkPitch(pitch(), leadCtx({ status: "EXCLUDED" }), log).join(" ")).toMatch(/excluded/);
    expect(checkPitch(pitch(), leadCtx({ status: "APPROVED" }), log).join(" ")).toMatch(/already approved/);
    expect(checkPitch(pitch({ contact_id: "C9" }), leadCtx(), log).join(" ")).toMatch(/contact/);
  });

  it("rejects offers the owner hasn't allowed", () => {
    expect(checkPitch(pitch(), leadCtx({ rules: { allowFreeExtra: false } }), log).join(" ")).toMatch(/free extras/);
    expect(checkPitch(pitch({ offer: "free_delivery" }), leadCtx({ rules: { allowFreeDelivery: false } }), log).join(" ")).toMatch(/free delivery/);
  });

  it("rejects invented numbers and wrong citations", () => {
    expect(checkPitch(pitch({ why: "They have 350 staff who eat lunch." }), leadCtx(), log).join(" ")).toMatch(/"350"/);
    expect(checkPitch(pitch({ why: "Save 20% on lunch." }), leadCtx(), log).join(" ")).toMatch(/20%/);
    expect(checkPitch(pitch({ evidence: [{ tool_call_id: "t1", field: "leads[0].fit_score", value: 90, label: "Fit" }] }), leadCtx(), log).join(" ")).toMatch(/cited 90/);
  });

  it("checks event pitches go to the event's venue, early enough", () => {
    expect(checkPitch(pitch({ event_id: "E1" }), leadCtx(), log).join(" ")).toMatch(/isn't the venue/);
    expect(checkPitch(pitch({ lead_id: "L2", contact_id: undefined, event_id: "E1" }), leadCtx(), log)).toEqual([]);
    expect(checkPitch(pitch({ lead_id: "L2", contact_id: undefined, event_id: "E2" }), leadCtx(), log).join(" ")).toMatch(/too soon/);
  });
});

describe("lead analyst run", () => {
  it("keeps the scripted analyst's valid pitches and blocks the invented lead", async () => {
    const out = await runLeadAnalysis(fakeLeadAnalyst(), leadCtx());
    expect(out.status).toBe("DONE");
    expect(out.pitches.map((p) => p.lead_id)).toEqual(["L1", "L2"]);
    expect(out.pitches[1].event_id).toBe("E1");
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reasons[0]).toMatch(/no lead/);
    expect(out.skipped.map((s) => s.lead_id)).toEqual(["L3"]);
  });

  it("without an analyst, pitches event venues and the best leads with the default offer", () => {
    const pitches = defaultPitches(leadCtx());
    expect(pitches[0]).toMatchObject({ lead_id: "L2", event_id: "E1", offer: "free_cookie_platter" });
    expect(pitches.map((p) => p.lead_id)).toEqual(["L2", "L1", "L3"]);
    expect(defaultPitches(leadCtx({ rules: { allowFreeExtra: false } }))[0].offer).toBe("free_delivery");
    expect(defaultPitches(leadCtx({ rules: { allowFreeExtra: false, allowFreeDelivery: false } }))).toEqual([]);
  });
});

describe("default picks", () => {
  it("respects the limit and exclusions", () => {
    const ctx = leadCtx();
    expect(defaultPitches(ctx, { limit: 1 })).toHaveLength(1);
    expect(defaultPitches(ctx, { exclude: new Set(["L1", "L2", "L3"]) })).toEqual([]);
  });
});

describe("pitch email copy", () => {
  const packet = {
    restaurant: { name: "Subway #00000", brand: "Subway", kind: "FRANCHISE" as const },
    offer: { key: "pitch:free_cookie_platter", title: "a free cookie platter with a first catering order", schedule: "Send this week", audience: "Northwind Labs", copyLabel: "Email subject" },
    facts: ["A free cookie platter with a first catering order of 10 or more people", "0.8 mi from Northwind Labs", "Weekly team lunches"],
    rules: { brandSafe: true, maxDiscountPct: 15, codePlaceholder: null },
    pitch: {
      company: "Northwind Labs",
      contactFirstName: "Jo",
      category: "office",
      distanceMiles: 0.8,
      offer: "a free cookie platter",
      minOrder: 10,
      occasion: "Weekly team lunches",
      event: null,
    },
  };

  it("accepts a pitch that sticks to the facts", () => {
    const copy = {
      headline: "Team lunch for Northwind Labs? A cookie platter on us",
      body: "Hi Jo,\n\nI run Subway #00000, 0.8 mi from you. For your first catering order of 10 or more people, a cookie platter is on us.\n\nThe team at Subway #00000\nSubway #00000 is independently owned and operated.",
    };
    expect(validateCopy(copy, packet)).toEqual([]);
    expect(validateCopy({ ...copy, body: `${copy.body} Save 20% today.` }, packet).join(" ")).toMatch(/20%/);
  });

  it("requires a franchise pitch to say it's independently owned", () => {
    const problems = validateCopy({ headline: "Lunch?", body: "Hi Jo, we'd love to cater your lunch." }, packet);
    expect(problems.join(" ")).toMatch(/independently owned/);
  });
});
