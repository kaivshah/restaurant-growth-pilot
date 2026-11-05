import type { AnalystModel, ToolCall } from "./models";

/**
 * Scripted catering-offer analyst for tests and ANALYST_PROVIDER=fake: reads
 * the targets and rules sent with the request and gives each target an offer
 * that fits the rules, citing the scan, so the whole pitch flow runs offline.
 */
export function fakeCateringAnalyst(): AnalystModel {
  return {
    provider: "fake",
    model: "scripted",
    start({ user }) {
      const seen = new Map<string, { id: string; output: Record<string, unknown> }>();
      for (const m of user.matchAll(/^\[(\S+)\] (\w+): (.*)$/gm)) seen.set(m[2], { id: m[1], output: JSON.parse(m[3]) });
      return {
        async send() {
          const rules = seen.get("get_rules")?.output as { max_discount_pct: number; brand_safe_mode: boolean; allowed: Record<string, boolean>; restaurant: { minCateringOrder: number } } | undefined;
          const list = seen.get("list_pitch_targets");
          const targets = (list?.output.targets ?? []) as { key: string; business: string; distance_miles: number; event: { title: string } | null }[];
          const pct = Math.min(10, rules?.max_discount_pct ?? 0);
          const priceCuts = rules?.allowed.amount_or_percent_off && pct > 0;
          const offers = targets.map((t, i) => ({
            key: t.key,
            title: priceCuts ? `${pct}% off your first catering order` : "Free delivery on your first catering order",
            mechanic: priceCuts ? "percent_off" : "free_delivery",
            ...(priceCuts ? { percent_off: pct } : {}),
            min_people: rules?.restaurant.minCateringOrder ?? 10,
            occasion: t.event ? `Lunch for ${t.event.title}` : "Team lunches",
            selling_points: [`Delivered from ${t.distance_miles} mi away`],
            why: `The scan shows ${t.business} is ${t.distance_miles} mi away${t.event ? `, hosting ${t.event.title}` : ""}; a first-order offer is the easiest way to win a regular catering customer.`,
            confidence: "medium",
            evidence: [{ tool_call_id: list!.id, field: `targets[${i}].distance_miles`, value: t.distance_miles, label: "Distance" }],
          }));
          const call: ToolCall = { id: "fake_submit_catering_offers", name: "submit_catering_offers", input: { offers } };
          return { toolCalls: [call], text: "", inputTokens: 1500, outputTokens: 300 };
        },
      };
    },
  };
}
