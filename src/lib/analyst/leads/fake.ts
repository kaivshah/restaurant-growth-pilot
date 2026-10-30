import type { AnalystModel, ToolCall } from "../models";

/**
 * Scripted lead analyst for tests and ANALYST_PROVIDER=fake: reads the
 * leads and events sent with the request, picks the best office and an event venue, and submits
 * one pitch for a lead that doesn't exist, so the checks can be seen working.
 */
export function fakeLeadAnalyst(): AnalystModel {
  return {
    provider: "fake",
    model: "scripted",
    start({ user }) {
      // The data comes with the request: "[data_2_list_leads] list_leads: {…}"
      const seen = new Map<string, { id: string; output: Record<string, unknown> }>();
      for (const m of user.matchAll(/^\[(\S+)\] (\w+): (.*)$/gm)) seen.set(m[2], { id: m[1], output: JSON.parse(m[3]) });
      const call = (name: string, input: unknown = {}): ToolCall => ({ id: `fake_${name}`, name, input });
      return {
        async send() {
          const turn = (toolCalls: ToolCall[]) => ({ toolCalls, text: "", inputTokens: 1500, outputTokens: 200 });
          const list = seen.get("list_leads");
          const events = seen.get("get_local_events");
          const leads = (list?.output.leads ?? []) as { lead_id: string; name: string; category: string; fit_score: number; distance_miles: number; contacts: number }[];
          const evs = (events?.output.events ?? []) as { event_id: string; title: string; venue_lead_id: string | null; attendance: number | null }[];
          const best = leads.find((l) => l.category === "office" && l.contacts > 0) ?? leads[0];
          const bi = leads.indexOf(best);
          const ev = evs.findIndex((e) => e.venue_lead_id && e.attendance);
          const pitches: unknown[] = [];
          if (best && list) {
            pitches.push({
              lead_id: best.lead_id,
              offer: "free_cookie_platter",
              occasion: "Weekly team lunches",
              why: `${best.name} is the best office nearby, only ${best.distance_miles} mi away, and we found a person who arranges food.`,
              confidence: "high",
              evidence: [
                { tool_call_id: list.id, field: `leads[${bi}].fit_score`, value: best.fit_score, label: "Fit score" },
                { tool_call_id: list.id, field: `leads[${bi}].distance_miles`, value: best.distance_miles, label: "Distance (mi)" },
              ],
            });
          }
          if (ev >= 0 && events) {
            const e = evs[ev];
            pitches.push({
              lead_id: e.venue_lead_id,
              event_id: e.event_id,
              offer: "free_delivery",
              occasion: `Staff and exhibitor lunches for ${e.title}`,
              why: `About ${e.attendance!.toLocaleString("en-US")} people are expected, and exhibitors and staff need lunch on site.`,
              confidence: "medium",
              evidence: [{ tool_call_id: events.id, field: `events[${ev}].attendance`, value: e.attendance, label: "Expected attendance" }],
            });
          }
          pitches.push({
            lead_id: "lead-that-does-not-exist",
            offer: "free_drinks_tray",
            occasion: "Office party for 5,000 people",
            why: "A huge company nearby.",
            confidence: "low",
            evidence: [{ tool_call_id: list?.id ?? "x", field: "leads[0].fit_score", value: 999, label: "Fit score" }],
          });
          const weakest = leads.at(-1);
          return turn([
            call("submit_pitches", {
              pitches,
              skipped: weakest && weakest !== best ? [{ lead_id: weakest.lead_id, reason: "Low fit and no contact found." }] : [],
            }),
          ]);
        },
      };
    },
  };
}
