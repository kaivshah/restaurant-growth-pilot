import type {
  DayPartReport,
  ParsedReport,
  WisrAdjCogsReport,
  WisrBreadOverShortReport,
  WisrInventoryCategoriesReport,
  WisrInventoryItemsReport,
  WisrSalesReport,
  WisrUnitsReport,
} from "@/lib/reports";

/**
 * Plain calculations from a store's confirmed reports. No AI here: every
 * number an offer quotes comes from this file and is unit-tested.
 */

export interface HourBar {
  label: string; // "3p"
  hour24: number;
  sales: number;
}

export interface Insights {
  period: { dayPart: string | null; wisr: string | null };
  netSales: number | null;
  cateringSales: number | null;
  customers: number | null;
  averageTicket: number | null;
  drinkPct: number | null;
  /** Average price of a drink, from WISR drink sales ÷ drinks sold */
  drinkPrice: number | null;
  discountDollars: number | null;
  discountPctOfSales: number | null;
  hourly: {
    bars: HourBar[];
    weekSales: number;
    /** Share of the week's sales in the 12 PM, 1 PM and 2 PM rows (noon–3 pm) */
    lunchShare: number;
    /** 3 PM + 4 PM rows (3–5 pm), Monday–Friday only */
    weekdayAfternoonSales: number;
    /** Average sales of one lunch hour vs one 3–5 pm hour, weekdays */
    lunchHourAvg: number;
    afternoonHourAvg: number;
  } | null;
  days: {
    totals: { day: string; sales: number }[];
    weekdayAvg: number;
    weekendAvg: number;
    busiest: { day: string; sales: number };
  } | null;
  bread: { surplusDays: { day: string; bread: number }[]; weekendSurplus: number } | null;
  overuse: { category: string; dollars: number }[];
  unitCosts: Record<string, number>;
}

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const WEEKEND_BREAD_DAYS = new Set(["Sat", "Sun", "Mon"]);

const round = (n: number, dp = 0) => Math.round(n * 10 ** dp) / 10 ** dp;

function latest<T extends ParsedReport["type"]>(reports: ParsedReport[], type: T) {
  const of = reports.filter((r): r is Extract<ParsedReport, { type: T }> => r.type === type);
  return of.sort((a, b) => (b.period?.end ?? "").localeCompare(a.period?.end ?? ""))[0];
}

function shortHour(h: number) {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function hourly(day: DayPartReport): Insights["hourly"] {
  // Opening hours = hours with positive sales; a late refund (negative sales) doesn't count.
  const open = day.hours.filter((h) => h.week.sales > 0);
  if (open.length === 0) return null;
  const first = Math.min(...open.map((h) => h.hour24));
  const last = Math.max(...open.map((h) => h.hour24));
  const bars = day.hours
    .filter((h) => h.hour24 >= first && h.hour24 <= last)
    .map((h) => ({ label: shortHour(h.hour24), hour24: h.hour24, sales: round(h.week.sales, 2) }));

  const weekSales = day.weekTotal.sales;
  const sumWeek = (hours: number[]) =>
    day.hours.filter((h) => hours.includes(h.hour24)).reduce((s, h) => s + h.week.sales, 0);
  const weekdayIdx = day.days.map((d, i) => (WEEKDAYS.has(d) ? i : -1)).filter((i) => i >= 0);
  const sumWeekdays = (hours: number[]) =>
    day.hours
      .filter((h) => hours.includes(h.hour24))
      .reduce((s, h) => s + weekdayIdx.reduce((t, i) => t + h.byDay[i].sales, 0), 0);

  const lunch = [12, 13, 14];
  const afternoon = [15, 16];
  const weekdayCount = Math.max(1, weekdayIdx.length);
  return {
    bars,
    weekSales: round(weekSales, 2),
    lunchShare: weekSales > 0 ? round((sumWeek(lunch) / weekSales) * 100) : 0,
    weekdayAfternoonSales: round(sumWeekdays(afternoon), 2),
    lunchHourAvg: round(sumWeekdays(lunch) / (lunch.length * weekdayCount), 2),
    afternoonHourAvg: round(sumWeekdays(afternoon) / (afternoon.length * weekdayCount), 2),
  };
}

function days(day: DayPartReport): Insights["days"] {
  const totals = day.days.map((d, i) => ({ day: d, sales: round(day.dayTotals[i].sales, 2) }));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const weekday = totals.filter((t) => WEEKDAYS.has(t.day)).map((t) => t.sales);
  const weekend = totals.filter((t) => !WEEKDAYS.has(t.day)).map((t) => t.sales);
  const busiest = totals.reduce((a, b) => (b.sales > a.sales ? b : a), totals[0]);
  return { totals, weekdayAvg: round(avg(weekday), 2), weekendAvg: round(avg(weekend), 2), busiest };
}

function bread(r: WisrBreadOverShortReport): Insights["bread"] {
  // Positive bread over/short means more bread on hand than the sales account for.
  const surplusDays = r.days.filter((d) => d.bread > 0).map((d) => ({ day: d.day, bread: d.bread }));
  const weekendSurplus = surplusDays.filter((d) => WEEKEND_BREAD_DAYS.has(d.day)).reduce((s, d) => s + d.bread, 0);
  return { surplusDays, weekendSurplus };
}

function overuse(r: WisrInventoryCategoriesReport) {
  // A negative $ DIFF means more was used than the sales would predict.
  const ingredientCategories = new Set(["CHEESE", "MEAT/PROTEIN", "BREAD/CARRIER", "VEGGIES", "TOPPINGS"]);
  return r.categories
    .filter((c) => ingredientCategories.has(c.category.toUpperCase()) && (c.diffDollars ?? 0) < 0)
    .map((c) => ({ category: c.category, dollars: Math.abs(c.diffDollars ?? 0) }))
    .sort((a, b) => b.dollars - a.dollars);
}

function unitCosts(r: WisrInventoryItemsReport) {
  const out: Record<string, number> = {};
  for (const i of r.items) if (!i.isSubtotal && i.unitCost !== null) out[i.item.toLowerCase()] = i.unitCost;
  return out;
}

export function computeInsights(reports: ParsedReport[]): Insights {
  const sales = latest(reports, "wisrSales") as WisrSalesReport | undefined;
  const units = latest(reports, "wisrUnits") as WisrUnitsReport | undefined;
  const cogs = latest(reports, "wisrAdjCogs") as WisrAdjCogsReport | undefined;
  const day = latest(reports, "dayPart") as DayPartReport | undefined;
  const breadReport = latest(reports, "wisrBreadOverShort") as WisrBreadOverShortReport | undefined;
  const cats = latest(reports, "wisrInventoryCategories") as WisrInventoryCategoriesReport | undefined;
  const items = latest(reports, "wisrInventoryItems") as WisrInventoryItemsReport | undefined;

  return {
    period: { dayPart: day?.period?.end ?? null, wisr: sales?.period?.end ?? units?.period?.end ?? null },
    netSales: sales?.netSales ?? null,
    cateringSales: sales?.cateringSales ?? null,
    customers: units?.customers ?? null,
    averageTicket: units?.averageTicket ?? null,
    drinkPct: units?.drinkPct ?? null,
    drinkPrice: sales && units && units.drinks > 0 ? round(sales.drinkSales / units.drinks, 2) : null,
    discountDollars: cogs?.totalDiscounts.dollars ?? null,
    discountPctOfSales: cogs?.discountPctOfSales ?? null,
    hourly: day ? hourly(day) : null,
    days: day ? days(day) : null,
    bread: breadReport ? bread(breadReport) : null,
    overuse: cats ? overuse(cats) : [],
    unitCosts: items ? unitCosts(items) : {},
  };
}
