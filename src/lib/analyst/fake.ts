import type { AnalystModel, ToolCall, ToolResult } from "./models";

/**
 * A scripted stand-in for a real model, used by tests and by local runs with
 * ANALYST_PROVIDER=fake. It explores like a real analyst would, then submits
 * one finding, three valid proposals and one that breaks the rules, so every
 * part of the pipeline (tools, checks, inbox) can be exercised offline.
 */
export function fakeAnalyst(): AnalystModel {
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
            for (const r of input as ToolResult[]) {
              if (!r.isError) seen.set(r.name, { id: r.id, output: JSON.parse(r.content) });
            }
          }
          step++;
          const turn = (toolCalls: ToolCall[]) => ({ toolCalls, text: "", inputTokens: 1200, outputTokens: 150 });
          if (step === 1) return turn([call("list_reports"), call("get_rules")]);
          if (step === 2) return turn([call("get_hourly_sales"), call("get_week_summary")]);

          const hourly = seen.get("get_hourly_sales");
          const week = seen.get("get_week_summary");
          if (!hourly || !week) return turn([call("submit_analysis", { findings: [], proposals: [], baseline_decisions: [] })]);
          const parts = hourly.output.day_parts as { part: string; sales: number; share_pct: number }[];
          const rows = hourly.output.rows as { hour24: number; sales: number }[];
          const dinnerIdx = parts.findIndex((p) => p.part.startsWith("dinner"));
          const lateIdx = parts.findIndex((p) => p.part.startsWith("late"));
          const sevenIdx = rows.findIndex((r) => r.hour24 === 19);
          const drinkPct = week.output.drink_attach_pct as number;

          return turn([
            call("submit_analysis", {
              findings: [
                {
                  title: "Evenings are quieter than lunch",
                  detail: `Dinner (5–8 pm) brings in ${parts[dinnerIdx].share_pct}% of the week's sales and late evening ${parts[lateIdx].share_pct}%.`,
                  evidence: [
                    { tool_call_id: hourly.id, field: `day_parts[${dinnerIdx}].share_pct`, value: parts[dinnerIdx].share_pct, label: "Dinner share of sales" },
                    { tool_call_id: hourly.id, field: `day_parts[${lateIdx}].share_pct`, value: parts[lateIdx].share_pct, label: "Late-evening share of sales" },
                  ],
                },
              ],
              proposals: [
                {
                  title: "Free chips with any footlong, 7–9 pm",
                  target: "slow_hours",
                  goal: "grow_sales",
                  mechanic: "free_item",
                  item: "chips",
                  qualifying_purchase: "any footlong",
                  value_usd: 1,
                  days: ["Mon", "Tue", "Wed", "Thu"],
                  start_hour: 19,
                  end_hour: 21,
                  duration_weeks: 3,
                  audience: "email_and_qr",
                  why: `Your Day Part report shows late evening is only ${parts[lateIdx].share_pct}% of sales and only ${drinkPct}% of orders include a drink, so a small free extra can lift evening visits.`,
                  expected_effect: "More footlong orders between 7 and 9 pm on weeknights; compare redemptions with the same hours now.",
                  confidence: "medium",
                  evidence: [
                    { tool_call_id: hourly.id, field: `day_parts[${lateIdx}].share_pct`, value: parts[lateIdx].share_pct, label: "Late-evening share of sales" },
                    ...(sevenIdx >= 0 ? [{ tool_call_id: hourly.id, field: `rows[${sevenIdx}].sales`, value: rows[sevenIdx].sales, label: "Sales in the 7 pm hour" }] : []),
                    { tool_call_id: week.id, field: "drink_attach_pct", value: drinkPct, label: "Orders with a drink" },
                  ],
                },
                ...(typeof week.output.customers === "number" && typeof week.output.average_sandwich_price === "number"
                  ? [
                      {
                        title: "Free 6-inch sub after 6 visits",
                        target: "retain_regulars",
                        goal: "retain",
                        mechanic: "loyalty_reward",
                        item: "6-inch sub",
                        qualifying_purchase: "any meal, 6 times",
                        value_usd: week.output.average_sandwich_price,
                        visits_required: 6,
                        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                        start_hour: 10,
                        end_hour: 21,
                        duration_weeks: 8,
                        audience: "email_list",
                        why: `Your WISR Units Summary shows about ${week.output.customers} customers a week but no way to bring them back; a reward on the 6th visit gives regulars a reason to return.`,
                        expected_effect: "More repeat visits from the email list; count rewards earned.",
                        confidence: "medium",
                        evidence: [
                          { tool_call_id: week.id, field: "customers", value: week.output.customers, label: "Customers a week" },
                          { tool_call_id: week.id, field: "average_sandwich_price", value: week.output.average_sandwich_price, label: "Average sandwich price" },
                        ],
                      },
                      {
                        title: "Free cookie for joining our email list",
                        target: "new_customers",
                        goal: "attract",
                        mechanic: "free_item",
                        item: "cookie",
                        qualifying_purchase: "none",
                        value_usd: 1,
                        for_sign_up: true,
                        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                        start_hour: 10,
                        end_hour: 21,
                        duration_weeks: 8,
                        audience: "in_store_qr",
                        why: `Your WISR Units Summary shows about ${week.output.customers} customers a week, none of them on a list yet; a small sign-up gift starts the list the other offers are sent to.`,
                        expected_effect: "Sign-ups per week.",
                        confidence: "medium",
                        evidence: [{ tool_call_id: week.id, field: "customers", value: week.output.customers, label: "Customers a week" }],
                      },
                    ]
                  : []),
                {
                  title: "20% off every footlong on Sundays",
                  target: "slow_days",
                  goal: "attract",
                  mechanic: "percent_off",
                  item: "footlong",
                  qualifying_purchase: "none",
                  percent_off: 20,
                  days: ["Sun"],
                  start_hour: 11,
                  end_hour: 20,
                  duration_weeks: 2,
                  audience: "email_list",
                  why: "Sundays are slow, so a big discount will fill the store.",
                  expected_effect: "Busier Sundays.",
                  confidence: "low",
                  evidence: [{ tool_call_id: week.id, field: "net_sales", value: 99999, label: "Net sales" }],
                },
              ],
              baseline_decisions: [],
            }),
          ]);
        },
      };
    },
  };
}
