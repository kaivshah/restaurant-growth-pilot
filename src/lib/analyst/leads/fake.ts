import type { AnalystModel, ToolCall, ToolResult } from "../models";

/**
 * Scripted lead analyst for tests and ANALYST_PROVIDER=fake: looks at the
 * leads and events, pitches the best office and an event venue, and submits
 * one pitch for a lead that doesn't exist, so the checks can be seen working.
 */
export function fakeLeadAnalyst(): AnalystModel {
  return {
    provider: "fake",
    model: "scripted",
    start() {
      let step = 0;
      const seen = new Map<string, { id: string; output: Record<string, unknown> }>();
      const call = (name: string, input: unknown = {}): ToolCall => ({ id: `fake_${step}_${name}`, name, input });
      return {
        async send(input) {
          if (Array.isArray(input)) {
            for (const r of input as ToolResult[]) if (!r.isError) seen.set(r.name, { id: r.id, output: JSON.parse(r.content) });
          }
          step++;
          const turn = (toolCalls: ToolCall[]) => ({ toolCalls, text: "", inputTokens: 1500, outputTokens: 200 });
          if (step === 1) return turn([call("list_leads"), call("get_rules"), call("get_local_events")]);

          const list = seen.get("list_leads");
          const events = seen.get("get_local_events");
          const leads = (list?.output.leads ?? []) as { lead_id: string; name: string; category: string; fit_score: number; distance_miles: number; contacts: number }[];
          const evs = (events?.output.events ?? []) as { event_id: string; title: string; venue_lead_id: string | null; attendance: number | null }[];
          const best = leads.find((l) => l.category === "office" && l.contacts > 0) ?? leads[0];
          if (step === 2 && best) return turn([call("get_lead", { lead_id: best.lead_id })]);

          const detail = seen.get("get_lead");
          const contacts = (detail?.output.contacts ?? []) as { contact_id: string }[];
          const bi = leads.indexOf(best);
          const ev = evs.findIndex((e) => e.venue_lead_id && e.attendance);
          const pitches: unknown[] = [];
          if (best && list) {
            pitches.push({
              lead_id: best.lead_id,
              contact_id: contacts[0]?.contact_id,
              offer: "free_cookie_platter",
              occasion: "Weekly team lunches",
              why: `${best.name} is the best-scoring office nearby (fit score ${best.fit_score}) and only ${best.distance_miles} mi away, and we found a person who arranges food.`,
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
