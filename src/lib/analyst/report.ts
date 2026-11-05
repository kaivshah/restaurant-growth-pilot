import type { AnalystContext } from "./context";
import { TOOLS_BY_NAME } from "./tools";

/**
 * The store report the owner reads: built from the same data tools the AI
 * analyst calls, so the page shows exactly the numbers the AI works from.
 * No AI here, so it's free and instant.
 */

type Obj = Record<string, unknown>;

const run = (ctx: AnalystContext, name: string, input: unknown = {}): Obj | null => {
  const t = TOOLS_BY_NAME.get(name)!;
  const out = t.run(ctx, t.parse(input)) as Obj;
  return out && !("error" in out) ? out : null;
};

export interface Highlight {
  tone: "good" | "watch" | "info";
  title: string;
  detail: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hourName = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

type ReportData = Record<"reports" | "week" | "trend" | "hourly" | "days" | "mix" | "discounts" | "stock" | "bread" | "daily", Obj | null>;
export type StoreReport = ReportData & { highlights: Highlight[] };

export function buildStoreReport(ctx: AnalystContext): StoreReport {
  const data: ReportData = {
    reports: run(ctx, "list_reports"),
    week: run(ctx, "get_week_summary"),
    trend: run(ctx, "get_weekly_trend"),
    hourly: run(ctx, "get_hourly_sales"),
    days: run(ctx, "get_day_totals"),
    mix: run(ctx, "get_sales_mix"),
    discounts: run(ctx, "get_discount_breakdown"),
    stock: run(ctx, "get_inventory_usage"),
    bread: run(ctx, "get_bread_over_short"),
    daily: run(ctx, "get_daily_sales"),
  };
  return { ...data, highlights: highlights(data) };
}

/** What stands out, in plain words, each with its numbers. Strongest signals first. */
function highlights(d: ReportData): Highlight[] {
  const out: Highlight[] = [];
  const weeks = num(d.trend?.weeks) ?? 0;
  const change = (d.trend?.change_first_to_last_pct ?? {}) as Record<string, number | null>;

  const sales = change.net_sales ?? change.daypart_sales;
  if (weeks >= 2 && sales != null && Math.abs(sales) >= 3) {
    out.push({
      tone: sales > 0 ? "good" : "watch",
      title: `Sales ${sales > 0 ? "up" : "down"} ${Math.abs(sales)}% over ${weeks} weeks`,
      detail: `From the first week you uploaded to the latest.${change.customers != null ? ` Customers ${change.customers >= 0 ? "up" : "down"} ${Math.abs(change.customers)}%` : ""}${change.average_ticket != null ? `, average order ${change.average_ticket >= 0 ? "up" : "down"} ${Math.abs(change.average_ticket)}%.` : "."}`,
    });
  }

  const rows = (d.hourly?.rows ?? []) as { hour24: number; sales: number }[];
  const open = rows.filter((r) => r.sales > 0);
  if (open.length >= 4) {
    const peak = open.reduce((a, b) => (b.sales > a.sales ? b : a));
    const daytime = open.filter((r) => r.hour24 >= 10 && r.hour24 <= 19 && r.hour24 !== peak.hour24);
    const slow = daytime.length ? daytime.reduce((a, b) => (b.sales < a.sales ? b : a)) : null;
    if (slow && slow.sales < peak.sales * 0.5) {
      out.push({
        tone: "watch",
        title: `${hourName(slow.hour24)} is your slowest daytime hour`,
        detail: `It brings in about ${money(slow.sales)} a week, against ${money(peak.sales)} at ${hourName(peak.hour24)}, your busiest hour. Your kitchen has room then: a good time for an offer or for preparing catering.`,
      });
    }
  }

  const days = (d.days?.days ?? []) as { day: string; sales: number }[];
  if (days.length >= 5) {
    const best = days.reduce((a, b) => (b.sales > a.sales ? b : a));
    const worst = days.reduce((a, b) => (b.sales < a.sales ? b : a));
    if (worst.sales < best.sales * 0.8) {
      out.push({ tone: "watch", title: `${worst.day} is your weakest day`, detail: `About ${money(worst.sales)} on a typical ${worst.day}, against ${money(best.sales)} on ${best.day}.` });
    }
  }

  const drink = num(d.week?.drink_attach_pct);
  if (drink != null && drink < 50) {
    out.push({ tone: "watch", title: `Only ${drink}% of orders include a drink`, detail: "Drinks cost little to serve, so a drink with a meal is a cheap way to raise the average order." });
  }

  const mix = (d.mix?.sandwich_mix ?? []) as { item: string; share_pct: number | null }[];
  const six = mix.find((m) => m.item === "six_inch")?.share_pct;
  const foot = mix.find((m) => m.item === "footlong")?.share_pct;
  if (six != null && foot != null && six > foot) {
    out.push({ tone: "info", title: `More 6-inch (${six}%) than footlong (${foot}%) sales`, detail: "A footlong upgrade offer could lift the average order." });
  }

  const catering = num(d.week?.catering_sales);
  const net = num(d.week?.net_sales);
  if (catering != null && net) {
    const pct = Math.round((catering / net) * 100);
    out.push(
      catering > 0
        ? { tone: "info", title: `Catering is ${pct}% of sales`, detail: `About ${money(catering)} a week. Nearby offices and events are on the Leads page.` }
        : { tone: "watch", title: "No catering sales yet", detail: "Every catering order would be new business. See the Leads page for nearby offices and events." },
    );
  }

  const disc = num(d.week?.discounts_pct_of_sales);
  if (disc != null && disc >= 10) {
    out.push({ tone: "watch", title: `Discounts already take ${disc}% of sales`, detail: "New offers should be aimed at a slow time or a bigger order, not given to everyone." });
  }

  const cats = (d.stock?.categories ?? []) as { category: string; diff_dollars: number | null }[];
  // Real stock categories only, not the report's total lines.
  const over = cats.filter((c) => (c.diff_dollars ?? 0) < 0 && !/total|cost of goods|food cost|paper/i.test(c.category)).sort((a, b) => (a.diff_dollars ?? 0) - (b.diff_dollars ?? 0))[0];
  if (over && Math.abs(over.diff_dollars!) >= 20) {
    out.push({ tone: "watch", title: `${over.category}: about ${money(Math.abs(over.diff_dollars!))} more used than sales explain`, detail: "Waste or over-portioning, from the inventory report. Worth a look with the team." });
  }

  const bestDate = (d.daily?.best_dates as { date: string; weekday: string; net_sales: number }[] | undefined)?.[0];
  const avgDay = num(d.daily?.average_per_day);
  if (bestDate && avgDay && bestDate.net_sales > avgDay * 1.3) {
    out.push({ tone: "info", title: `Best day: ${bestDate.weekday} ${bestDate.date}`, detail: `${money(bestDate.net_sales)}, against ${money(avgDay)} on an average day. If something special happened that day, it may be worth repeating.` });
  }
  return out;
}
