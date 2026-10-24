import { describe, expect, it } from "vitest";
import { parseWebEvents, webEventsPrompt } from "./web";

const from = new Date("2026-10-25T00:00:00Z");
const to = new Date("2026-12-24T00:00:00Z");

describe("web event search", () => {
  it("reads events from the model's reply, even with text around the JSON", () => {
    const reply = `Here is what I found:
[
  {"title": "San Diego Biotech Summit", "date": "2026-11-14", "end_date": "2026-11-15", "category": "conference", "venue": "Hilton Del Mar", "address": "15575 Jimmy Durante Blvd, Del Mar, CA", "organizer": "Biocom", "expected_attendance": 800, "description": "Annual summit.", "url": "https://example.com/summit"},
  {"title": "Too late", "date": "2027-03-01", "category": "expo"},
  {"title": "No date", "date": "soon"},
  {"title": "san diego biotech summit", "date": "2026-11-14"},
  {"title": "Company all-hands", "date": "2026-11-20", "category": "party-time", "url": "not a url", "expected_attendance": "about 100"}
]`;
    const events = parseWebEvents(reply, from, to, ["https://source.example/page"]);
    expect(events.map((e) => e.title)).toEqual(["San Diego Biotech Summit", "Company all-hands"]);
    expect(events[0]).toMatchObject({ source: "web", category: "conference", venueName: "Hilton Del Mar", organizer: "Biocom", attendance: 800, url: "https://example.com/summit", location: null });
    expect(events[0].endsAt?.toISOString().slice(0, 10)).toBe("2026-11-15");
    // Unknown category → other, a made-up URL → the page Google Search found, a vague number → none
    expect(events[1]).toMatchObject({ category: "other", url: "https://source.example/page", attendance: null });
  });

  it("returns nothing for replies without a JSON list", () => {
    expect(parseWebEvents("I couldn't find any events.", from, to)).toEqual([]);
    expect(parseWebEvents("[not json]", from, to)).toEqual([]);
  });

  it("asks for corporate events at the companies we found", () => {
    const prompt = webEventsPrompt({ address: "1915 El Cajon Blvd, San Diego, CA", radiusMiles: 5, from, to, companies: ["Intuit Inc", "Arm, Inc."] });
    expect(prompt).toContain("Intuit Inc; Arm, Inc.");
    expect(prompt).toContain("2026-10-25 and 2026-12-24");
    expect(prompt).toContain("within about 5 miles of 1915 El Cajon Blvd");
  });
});
