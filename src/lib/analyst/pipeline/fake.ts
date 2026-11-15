import type { AnalystModel, ToolCall } from "../models";

/**
 * A scripted stand-in for the pipeline's three stages, for tests and local
 * runs with ANALYST_PROVIDER=fake. It reads the data sent with the request
 * (the cached prefix), tells the stage from the ask, and answers like a
 * careful model would: findings with a calculation, a dozen candidates (two
 * of them wrong on purpose), and a critique that picks five.
 */
export function fakePipeline(): AnalystModel {
  return {
    provider: "fake",
    model: "scripted-pipeline",
    start({ user, cachedPrefix }) {
      const seen = new Map<string, { id: string; output: Record<string, unknown> }>();
      for (const m of `${cachedPrefix ?? ""}\n${user}`.matchAll(/^\[(\S+)\] (\w+): (.*)$/gm)) seen.set(m[2], { id: m[1], output: JSON.parse(m[3]) });
      const stage = /Stage: (\w+)/.exec(user)?.[1] ?? "DIAGNOSE";
      let n = 0;
      const call = (name: string, input: unknown): ToolCall => ({ id: `fake_${stage}_${++n}`, name, input });
      const turn = (c: ToolCall) => ({ toolCalls: [c], text: "", inputTokens: 3000, outputTokens: 600 });
      return {
        async send() {
          const hourly = seen.get("get_hourly_sales")!;
          const week = seen.get("get_week_summary")!;
          const rows = hourly.output.rows as { hour24: number; sales: number }[];
          const parts = hourly.output.day_parts as { part: string; share_pct: number }[];
          const noon = rows.findIndex((r) => r.hour24 === 12);
          const three = rows.findIndex((r) => r.hour24 === 15);
          const lateIdx = parts.findIndex((p) => p.part.startsWith("late"));
          const drinkPct = week.output.drink_attach_pct as number;
          const customers = week.output.customers as number;
          const ratio = Math.round((rows[three].sales / rows[noon].sales) * 1000) / 10;

          if (stage === "DIAGNOSE") {
            return turn(
              call("submit_diagnosis", {
                findings: [
                  {
                    title: "3 pm sells a fraction of noon",
                    detail: `Your Day Part report shows the 3 pm hour brings in ${ratio}% of what the noon hour does.`,
                    kind: "weakness",
                    calculations: [{ label: "3 pm sales as a share of noon sales", inputs: [{ name: "a", tool_call_id: hourly.id, field: `rows[${three}].sales`, value: rows[three].sales }, { name: "b", tool_call_id: hourly.id, field: `rows[${noon}].sales`, value: rows[noon].sales }], formula: "a / b * 100", result: ratio }],
                    evidence: [],
                  },
                  {
                    title: "Few orders include a drink",
                    detail: `Your WISR Units Summary shows only ${drinkPct}% of orders include a drink.`,
                    kind: "weakness",
                    calculations: [],
                    evidence: [{ tool_call_id: week.id, field: "drink_attach_pct", value: drinkPct, label: "Orders with a drink" }],
                  },
                  {
                    title: "Late evening is quiet",
                    detail: `Your Day Part report shows late evening is ${parts[lateIdx].share_pct}% of the week's sales.`,
                    kind: "weakness",
                    calculations: [],
                    evidence: [{ tool_call_id: hourly.id, field: `day_parts[${lateIdx}].share_pct`, value: parts[lateIdx].share_pct, label: "Late-evening share" }],
                  },
                  {
                    title: "Invented finding",
                    detail: "Sales fell 27% last month.",
                    kind: "change",
                    calculations: [],
                    evidence: [{ tool_call_id: week.id, field: "net_sales", value: 1, label: "Net sales" }],
                  },
                ],
              }),
            );
          }

          const base = (key: string, title: string, target: string, goal: string, item: string, over: Record<string, unknown> = {}) => ({
            key,
            title,
            target,
            goal,
            mechanic: "free_item",
            item,
            qualifying_purchase: "any footlong",
            value_usd: 1,
            days: ["Mon", "Tue", "Wed", "Thu"],
            start_hour: 15,
            end_hour: 17,
            duration_weeks: 3,
            audience: "email_and_qr",
            why: `Your Day Part report shows the 3 pm hour sells ${ratio}% of the noon hour, so a small gift in that window brings visits when the kitchen is quiet.`,
            expected_effect: "More orders 3–5 pm on weekdays.",
            confidence: "medium",
            answers_finding: 1,
            idea_source: "Happy hour",
            evidence: [{ tool_call_id: "calc_1", field: "calculations[0].result", value: ratio, label: "3 pm as a share of noon" }],
            ...over,
          });
          if (stage === "STRATEGISE") {
            const retry = /Propose \d+ more/.test(user);
            const list = retry
              ? [base("c20", "Free apple slices with a kids' meal, 3–5 pm", "add_ons", "grow_sales", "apple slices", { qualifying_purchase: "a kids' meal" })]
              : [
                  base("c1", "Free chips with any footlong, 3–5 pm", "slow_hours", "grow_sales", "chips"),
                  base("c2", "Free fountain drink with any footlong, Mon–Thu 3–5 pm", "drink_attach", "grow_sales", "fountain drink", { answers_finding: 2, why: `Your WISR Units Summary shows only ${drinkPct}% of orders include a drink; a drink with a footlong in the quiet afternoon lifts both.` }),
                  base("c3", "Free 6-inch sub after 6 visits", "retain_regulars", "retain", "6-inch sub", { mechanic: "loyalty_reward", visits_required: 6, qualifying_purchase: "any meal, 6 times", value_usd: 7, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], start_hour: 10, end_hour: 21, duration_weeks: 8, audience: "email_list", answers_finding: 2, why: `Your WISR Units Summary shows about ${customers} customers a week and no list to bring them back; a reward on the 6th visit gives regulars a reason.`, evidence: [{ tool_call_id: week.id, field: "customers", value: customers, label: "Customers a week" }], idea_source: "Punch card" }),
                  base("c4", "Free cookie for joining our email list", "new_customers", "attract", "cookie", { qualifying_purchase: "none", for_sign_up: true, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], start_hour: 10, end_hour: 21, duration_weeks: 8, audience: "in_store_qr", answers_finding: 2, why: `Your WISR Units Summary shows about ${customers} customers a week, none on a list yet; a sign-up gift starts the list.`, evidence: [{ tool_call_id: week.id, field: "customers", value: customers, label: "Customers a week" }], idea_source: "First-visit gift" }),
                  base("c5", "Free cookie with any footlong, 7–9 pm", "slow_hours", "grow_sales", "cookie", { start_hour: 19, end_hour: 21, answers_finding: 3, why: `Your Day Part report shows late evening is ${parts[lateIdx].share_pct}% of sales; a cookie with a footlong brings evening orders.`, evidence: [{ tool_call_id: hourly.id, field: `day_parts[${lateIdx}].share_pct`, value: parts[lateIdx].share_pct, label: "Late-evening share" }] }),
                  base("c6", "20% off every footlong on Sundays", "slow_days", "attract", "footlong", { mechanic: "percent_off", percent_off: 20, value_usd: undefined, qualifying_purchase: "none", days: ["Sun"], start_hour: 11, end_hour: 20, why: "Sundays are slow, so a big discount will fill the store.", evidence: [{ tool_call_id: week.id, field: "net_sales", value: 99999, label: "Net sales" }], idea_source: "original" }),
                  base("c7", "Bring-a-friend: two footlongs for the price of one and a half, Tue 5–8 pm", "bigger_orders", "attract", "second footlong", { mechanic: "bogo", value_usd: 3, qualifying_purchase: "a footlong", days: ["Tue"], start_hour: 17, end_hour: 20, idea_source: "Bring-a-friend", why: `Your Day Part report shows late evening is ${parts[lateIdx].share_pct}% of sales; two people for one order on a quiet evening lifts the average order.`, evidence: [{ tool_call_id: hourly.id, field: `day_parts[${lateIdx}].share_pct`, value: parts[lateIdx].share_pct, label: "Late-evening share" }] }),
                ];
            return turn(call("submit_strategy", { candidates: list }));
          }
          // CRITIQUE
          const keys = [...user.matchAll(/^(c\d+): /gm)].map((m) => m[1]);
          const scores = keys.map((key) => ({ key, expected_lift: key === "c6" ? 2 : 4, cost_efficiency: key === "c3" ? 3 : 4, fit: 4, novelty: key === "c5" ? 2 : 4, verdict: key === "c6" ? "drop" : "pick", reason: key === "c6" ? "A blanket 20% off cuts full-price sales without a reason in the data." : "Targets a real weak spot at the time it happens." }));
          return turn(call("submit_critique", { scores, picked: ["c1", "c2", "c3", "c4", "c7"] }));
        },
      };
    },
  };
}
