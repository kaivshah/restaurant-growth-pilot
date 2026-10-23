import { z } from "zod";
import type { ParsedReport } from "@/lib/reports";
import { REPORT_LABELS } from "@/lib/reports";
import { type AnalystContext, pick, sourceLabel, weeksOf } from "./context";

/**
 * Read-only tools the AI analyst calls to explore a store's data. Each
 * returns small aggregates with a `source`, never raw files. Rent, labor,
 * royalties and profit are deliberately not exposed.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the input, sent to the model */
  inputSchema: Record<string, unknown>;
}

export interface ToolDef<A = unknown> extends ToolSpec {
  parse: (input: unknown) => A;
  run: (ctx: AnalystContext, args: A) => unknown;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

const WEEK = { type: "string", description: "Week end date (yyyy-mm-dd) from list_reports. Omit for the latest week." };
const noData = (what: string) => ({ error: `No ${what} uploaded yet.` });

/** Typed while defining, erased in the list: parse() always runs before run(). */
function tool<A>(def: ToolDef<A>): ToolDef<unknown> {
  return def as unknown as ToolDef<unknown>;
}

const weekArg = z.object({ week: z.string().optional() }).passthrough();

export const DATA_TOOLS: ToolDef<unknown>[] = [
  tool({
    name: "list_reports",
    description: "List the uploaded reports with their weeks. Call this first to see what data exists.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: () => ({}),
    run: (ctx) => ({
      reports: ctx.reports.map(({ report, status }) => ({
        type: report.type,
        label: REPORT_LABELS[report.type],
        week_start: report.period?.start ?? null,
        week_end: report.period?.end ?? null,
        confirmed_by_owner: status === "CONFIRMED",
      })),
    }),
  }),

  tool({
    name: "get_week_summary",
    description:
      "Weekly sales and customer numbers from the WISR sales, units and discount reports: net sales, unit/drink/misc/catering sales, footlong and 6-inch counts, customers, average ticket, drink attach %, discounts, and cost of goods %.",
    inputSchema: { type: "object", properties: { week: WEEK }, additionalProperties: false },
    parse: (i) => weekArg.parse(i ?? {}),
    run: (ctx, { week }) => {
      const sales = pick(ctx, "wisrSales", week);
      const units = pick(ctx, "wisrUnits", week ?? sales?.period?.end);
      const cogs = pick(ctx, "wisrAdjCogs", week ?? sales?.period?.end);
      if (!sales && !units) return noData("WISR sales or units report");
      return {
        source: [sales, units, cogs].filter(Boolean).map((r) => sourceLabel(r as ParsedReport)),
        week_end: sales?.period?.end ?? units?.period?.end ?? null,
        net_sales: sales?.netSales ?? null,
        unit_sales: sales?.unitSales ?? null,
        drink_sales: sales?.drinkSales ?? null,
        misc_sales: sales?.miscSales ?? null,
        catering_sales: sales?.cateringSales ?? null,
        local_advertising: sales?.localAdvertising ?? null,
        cost_of_goods: sales?.costOfGoods ?? null,
        cost_of_goods_pct: sales && sales.netSales ? r1((sales.costOfGoods / sales.netSales) * 100) : null,
        footlongs: units?.footlong ?? null,
        six_inch: units?.sixInch ?? null,
        salads: units?.salads ?? null,
        total_units: units?.totalUnits ?? null,
        customers: units?.customers ?? null,
        average_ticket: units?.averageTicket ?? null,
        drinks_sold: units?.drinks ?? null,
        drink_attach_pct: units?.drinkPct ?? null,
        average_drink_price: sales && units && units.drinks ? r2(sales.drinkSales / units.drinks) : null,
        catering_units: units?.catering ?? null,
        discounts_total: cogs?.totalDiscounts.dollars ?? null,
        discounts_pct_of_sales: cogs?.discountPctOfSales ?? null,
      };
    },
  }),

  tool({
    name: "get_hourly_sales",
    description:
      "Sales, units, customers and average ticket by hour from the day-part report. Give `day` (Mon…Sun) for one day, or omit it for the whole week. Each row includes its share of the week's (or day's) sales.",
    inputSchema: {
      type: "object",
      properties: { week: WEEK, day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } },
      additionalProperties: false,
    },
    parse: (i) => weekArg.extend({ day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).optional() }).parse(i ?? {}),
    run: (ctx, { week, day }) => {
      const dp = pick(ctx, "dayPart", week);
      if (!dp) return noData("day-part report");
      const di = day ? dp.days.indexOf(day) : -1;
      if (day && di < 0) return { error: `The report has no column for ${day}.` };
      const cellOf = (h: (typeof dp.hours)[number]) => (di >= 0 ? h.byDay[di] : h.week);
      const total = di >= 0 ? dp.dayTotals[di].sales : dp.weekTotal.sales;
      const rows = dp.hours
        .map((h) => ({ hour: h.label, hour24: h.hour24, ...cellOf(h) }))
        .filter((r) => r.sales !== 0 || r.customers !== 0)
        .map((r) => ({
          hour: r.hour,
          hour24: r.hour24,
          sales: r2(r.sales),
          units: r.units,
          customers: r.customers,
          avg_ticket: r2(r.avgTicket),
          share_pct: total ? r1((r.sales / total) * 100) : 0,
        }));
      const parts = [
        { name: "morning (before 11 am)", hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        { name: "lunch (11 am–2 pm)", hours: [11, 12, 13] },
        { name: "afternoon (2–5 pm)", hours: [14, 15, 16] },
        { name: "dinner (5–8 pm)", hours: [17, 18, 19] },
        { name: "late (8 pm onwards)", hours: [20, 21, 22, 23] },
      ].map((p) => {
        const sales = dp.hours.filter((h) => p.hours.includes(h.hour24)).reduce((s, h) => s + cellOf(h).sales, 0);
        return { part: p.name, sales: r2(sales), share_pct: total ? r1((sales / total) * 100) : 0 };
      });
      return { source: sourceLabel(dp), day: day ?? "whole week", total_sales: r2(total), day_parts: parts, rows };
    },
  }),

  tool({
    name: "get_day_totals",
    description: "Sales, customers and average ticket for each day of the week, from the day-part report.",
    inputSchema: { type: "object", properties: { week: WEEK }, additionalProperties: false },
    parse: (i) => weekArg.parse(i ?? {}),
    run: (ctx, { week }) => {
      const dp = pick(ctx, "dayPart", week);
      if (!dp) return noData("day-part report");
      return {
        source: sourceLabel(dp),
        days: dp.days.map((d, i) => ({
          day: d,
          sales: r2(dp.dayTotals[i].sales),
          customers: dp.dayTotals[i].customers,
          avg_ticket: r2(dp.dayTotals[i].avgTicket),
        })),
        week_sales: r2(dp.weekTotal.sales),
        week_customers: dp.weekTotal.customers,
      };
    },
  }),

  tool({
    name: "compare_weeks",
    description:
      "Compare one number between two weeks and get the change. Metrics: net_sales, customers, average_ticket, drink_attach_pct, discounts_pct_of_sales, catering_sales (WISR), or daypart_sales, daypart_customers (day-part report).",
    inputSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["net_sales", "customers", "average_ticket", "drink_attach_pct", "discounts_pct_of_sales", "catering_sales", "daypart_sales", "daypart_customers"],
        },
        week_a: { type: "string", description: "Earlier week end date" },
        week_b: { type: "string", description: "Later week end date" },
      },
      required: ["metric", "week_a", "week_b"],
      additionalProperties: false,
    },
    parse: (i) =>
      z
        .object({
          metric: z.enum(["net_sales", "customers", "average_ticket", "drink_attach_pct", "discounts_pct_of_sales", "catering_sales", "daypart_sales", "daypart_customers"]),
          week_a: z.string(),
          week_b: z.string(),
        })
        .parse(i),
    run: (ctx, { metric, week_a, week_b }) => {
      const value = (week: string): { v: number | null; source?: string } => {
        if (metric === "daypart_sales" || metric === "daypart_customers") {
          const dp = pick(ctx, "dayPart", week);
          return dp ? { v: metric === "daypart_sales" ? r2(dp.weekTotal.sales) : dp.weekTotal.customers, source: sourceLabel(dp) } : { v: null };
        }
        if (metric === "net_sales" || metric === "catering_sales") {
          const s = pick(ctx, "wisrSales", week);
          return s ? { v: metric === "net_sales" ? s.netSales : s.cateringSales, source: sourceLabel(s) } : { v: null };
        }
        if (metric === "discounts_pct_of_sales") {
          const c = pick(ctx, "wisrAdjCogs", week);
          return c ? { v: c.discountPctOfSales, source: sourceLabel(c) } : { v: null };
        }
        const u = pick(ctx, "wisrUnits", week);
        if (!u) return { v: null };
        const v = metric === "customers" ? u.customers : metric === "average_ticket" ? u.averageTicket : u.drinkPct;
        return { v, source: sourceLabel(u) };
      };
      const a = value(week_a);
      const b = value(week_b);
      if (a.v === null || b.v === null) {
        return { error: "One of those weeks has no matching report.", weeks_available: weeksOf(ctx, metric.startsWith("daypart") ? "dayPart" : "wisrSales") };
      }
      return {
        source: [a.source, b.source],
        metric,
        week_a: { week: week_a, value: a.v },
        week_b: { week: week_b, value: b.v },
        change: r2(b.v - a.v),
        change_pct: a.v ? r1(((b.v - a.v) / a.v) * 100) : null,
      };
    },
  }),

  tool({
    name: "get_inventory_usage",
    description:
      "Ingredient and supply usage compared with what sales predict, from the WISR inventory reports. Negative diff_dollars means more was used than expected (waste or over-portioning). Includes the items with the largest differences when the items report is uploaded.",
    inputSchema: { type: "object", properties: { week: WEEK }, additionalProperties: false },
    parse: (i) => weekArg.parse(i ?? {}),
    run: (ctx, { week }) => {
      const cats = pick(ctx, "wisrInventoryCategories", week);
      const items = pick(ctx, "wisrInventoryItems", week);
      if (!cats && !items) return noData("inventory report");
      return {
        source: [cats, items].filter(Boolean).map((r) => sourceLabel(r as ParsedReport)),
        categories: cats?.categories.map((c) => ({
          category: c.category,
          used_dollars: c.usedDollars,
          diff_dollars: c.diffDollars,
          actual_pct: c.actualPct,
          expected_pct: c.expectedPct,
        })),
        biggest_item_differences: items?.items
          .filter((i) => !i.isSubtotal && i.diffDollars !== null && i.diffDollars !== 0)
          .sort((a, b) => Math.abs(b.diffDollars!) - Math.abs(a.diffDollars!))
          .slice(0, 12)
          .map((i) => ({ item: i.item, used: i.used, unit_cost: i.unitCost, diff_dollars: i.diffDollars })),
      };
    },
  }),

  tool({
    name: "get_item_costs",
    description: "What the store pays per unit for items (e.g. cookies, chips, bottled drinks), from the inventory items report.",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" }, maxItems: 10 } },
      required: ["items"],
      additionalProperties: false,
    },
    parse: (i) => z.object({ items: z.array(z.string()).max(10) }).parse(i),
    run: (ctx, { items }) => {
      const inv = pick(ctx, "wisrInventoryItems");
      if (!inv) return noData("inventory items report");
      return {
        source: sourceLabel(inv),
        items: items.map((q) => {
          const hit = inv.items.find((i) => !i.isSubtotal && i.item.toLowerCase().includes(q.toLowerCase()));
          return hit ? { query: q, item: hit.item, unit_cost: hit.unitCost } : { query: q, item: null, unit_cost: null };
        }),
      };
    },
  }),

  tool({
    name: "get_bread_over_short",
    description: "Bread over (+) or short (−) by day from the WISR daily cash/bread report. Positive means more bread on hand than sales account for.",
    inputSchema: { type: "object", properties: { week: WEEK }, additionalProperties: false },
    parse: (i) => weekArg.parse(i ?? {}),
    run: (ctx, { week }) => {
      const b = pick(ctx, "wisrBreadOverShort", week);
      if (!b) return noData("bread over/short report");
      return { source: sourceLabel(b), days: b.days.map((d) => ({ day: d.day, bread: d.bread })), total_bread: b.total?.bread ?? null };
    },
  }),

  tool({
    name: "get_discount_breakdown",
    description: "What the store already gives away: free units, employee discounts, value-meal and other discounts, as quantity and dollars, from the WISR adjusted cost of goods report.",
    inputSchema: { type: "object", properties: { week: WEEK }, additionalProperties: false },
    parse: (i) => weekArg.parse(i ?? {}),
    run: (ctx, { week }) => {
      const c = pick(ctx, "wisrAdjCogs", week);
      if (!c) return noData("adjusted cost of goods report");
      return {
        source: sourceLabel(c),
        free_units: c.freeUnits,
        employee_discounts: c.employeeDiscounts,
        value_meal_discounts: c.valueMealDiscounts,
        other_discounts: c.otherDiscounts,
        total: c.totalDiscounts,
        pct_of_sales: c.discountPctOfSales,
      };
    },
  }),

  tool({
    name: "get_rules",
    description: "The owner's rules every offer must follow: largest discount, allowed offer types, whether promotions need brand approval, opening hours and catering settings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: () => ({}),
    run: (ctx) => ({
      source: "Owner's settings",
      restaurant: ctx.restaurant,
      max_discount_pct: ctx.rules.maxDiscountPct,
      brand_safe_mode: ctx.rules.promoApproval !== "YES",
      promotions_need_brand_approval: ctx.rules.promoApproval,
      allowed: {
        free_item: ctx.rules.allowFreeExtra,
        catering_free_delivery: ctx.rules.allowFreeDelivery,
        amount_or_percent_off: ctx.rules.allowPercentOff && ctx.rules.promoApproval === "YES",
        buy_one_get_one: ctx.rules.allowBogo && ctx.rules.promoApproval === "YES",
      },
      use_brand_catering_menu: ctx.rules.useBrandCateringMenu,
    }),
  }),

  tool({
    name: "get_past_decisions",
    description: "Offers the owner approved or skipped before, with their reasons. Use this to suggest things they are likely to accept.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: () => ({}),
    run: (ctx) => ({ source: "Approval Inbox history", decisions: ctx.pastDecisions }),
  }),

  tool({
    name: "estimate_offer_cost",
    description:
      "How generous an offer is: its value as a % of the average ticket, which must stay within the owner's limit. For a free item give its retail value if known (e.g. average_drink_price from get_week_summary); for $ off give the amount; for % off give the percent.",
    inputSchema: {
      type: "object",
      properties: {
        mechanic: { type: "string", enum: ["free_item", "amount_off", "percent_off", "bundle_price"] },
        value_usd: { type: "number", description: "Retail value of the free item, or the dollars off" },
        percent_off: { type: "number" },
      },
      required: ["mechanic"],
      additionalProperties: false,
    },
    parse: (i) =>
      z
        .object({
          mechanic: z.enum(["free_item", "amount_off", "percent_off", "bundle_price"]),
          value_usd: z.number().nonnegative().optional(),
          percent_off: z.number().min(0).max(100).optional(),
        })
        .parse(i),
    run: (ctx, args) => estimateOfferCost(ctx, args),
  }),
];

export function estimateOfferCost(
  ctx: AnalystContext,
  args: { mechanic: string; value_usd?: number; percent_off?: number },
): { source: string; value_pct_of_ticket: number | null; max_discount_pct: number; within_limit: boolean | null; note?: string } {
  const units = pick(ctx, "wisrUnits");
  const ticket = units?.averageTicket ?? null;
  const base = { source: units ? sourceLabel(units) : "No units report", max_discount_pct: ctx.rules.maxDiscountPct };
  if (args.mechanic === "percent_off") {
    if (args.percent_off === undefined) return { ...base, value_pct_of_ticket: null, within_limit: null, note: "Give percent_off." };
    return { ...base, value_pct_of_ticket: r1(args.percent_off), within_limit: args.percent_off <= ctx.rules.maxDiscountPct };
  }
  if (args.value_usd === undefined || !ticket) {
    return { ...base, value_pct_of_ticket: null, within_limit: null, note: ticket ? "Give value_usd." : "Average ticket unknown." };
  }
  const pct = r1((args.value_usd / ticket) * 100);
  return { ...base, value_pct_of_ticket: pct, within_limit: pct <= ctx.rules.maxDiscountPct };
}

export const TOOLS_BY_NAME = new Map(DATA_TOOLS.map((t) => [t.name, t]));
