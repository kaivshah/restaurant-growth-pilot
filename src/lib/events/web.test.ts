import { describe, expect, it, vi } from "vitest";
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

describe("Claude web event search", () => {
  it("searches near the store, continues a paused search, and reads the events and their pages", async () => {
    const { claudeWebEvents, placeOf } = await import("./web");
    expect(placeOf("100 Example Rd, San Diego, CA 92129")).toEqual({ city: "San Diego", region: "CA" });

    const bodies: { tools: { type: string; max_uses: number; user_location: Record<string, string> }[]; messages: unknown[] }[] = [];
    const from = new Date("2026-11-04T12:00:00Z");
    const to = new Date("2026-12-03T12:00:00Z");
    const replies = [
      // First turn: a search, then the server pauses the long turn.
      { content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "San Diego expos" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://example.com/expo", title: "Expo", encrypted_content: "x", page_age: null }] }], stop_reason: "pause_turn" },
      // Continued: the answer, split over text blocks the way cited answers are.
      { content: [{ type: "text", text: '[{"title":"Biotech Expo","date":"2026-11-20","category":"expo",' }, { type: "text", text: '"venue":"Convention Center","url":"https://example.com/expo"}]' }], stop_reason: "end_turn" },
    ];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        const r = replies[bodies.length - 1];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", ...r, usage: { input_tokens: 100, output_tokens: 50 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const events = await claudeWebEvents(`test-key-web-${port}`, "claude-opus-5-5").find({ address: "100 Example Rd, San Diego, CA 92129", radiusMiles: 3, from, to, companies: ["Acme"] });
      expect(bodies).toHaveLength(2);
      expect(bodies[0].tools[0]).toMatchObject({ type: "web_search_20260209", max_uses: 5, user_location: { type: "approximate", city: "San Diego", region: "CA", country: "US" } });
      expect(bodies[1].messages).toHaveLength(2); // the paused turn was sent back, with no extra "continue" message
      expect(events.map((e) => [e.title, e.category, e.venueName, e.url])).toEqual([["Biotech Expo", "expo", "Convention Center", "https://example.com/expo"]]);
    } finally {
      server.close();
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = before;
    }
  });

  it("is used when there's a Claude key", async () => {
    const { webEventsFromEnv } = await import("./web");
    expect(webEventsFromEnv({ ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
    expect(webEventsFromEnv({ ANTHROPIC_API_KEY: "k", WEB_EVENTS: "off" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(webEventsFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
