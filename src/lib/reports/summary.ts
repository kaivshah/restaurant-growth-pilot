import type { ParsedReport, Period } from "./types";

export interface CheckNumber {
  key: string;
  label: string;
  value: number;
  display: string;
  source: string;
}

export interface WeekSummary {
  period: Period | null;
  numbers: CheckNumber[];
}

const money = (n: number, cents = false) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });

/**
 * The handful of numbers we ask the owner to confirm, taken from whichever
 * WISR reports for one week are present.
 */
export function summarise(reports: ParsedReport[]): WeekSummary {
  const sales = reports.find((r) => r.type === "wisrSales");
  const units = reports.find((r) => r.type === "wisrUnits");
  const cogs = reports.find((r) => r.type === "wisrAdjCogs");
  const numbers: CheckNumber[] = [];

  if (sales) {
    numbers.push({ key: "netSales", label: "Net sales", value: sales.netSales, display: money(sales.netSales), source: "Sales Summary" });
  }
  if (units) {
    numbers.push(
      { key: "customers", label: "Customers", value: units.customers, display: units.customers.toLocaleString("en-US"), source: "Units Summary" },
      { key: "averageTicket", label: "Average ticket", value: units.averageTicket, display: money(units.averageTicket, true), source: "Units Summary" },
      { key: "drinkPct", label: "Orders with a drink", value: units.drinkPct, display: `${units.drinkPct}%`, source: "Units Summary" },
    );
  }
  if (cogs) {
    numbers.push({
      key: "discounts",
      label: "Discounts and free items",
      value: cogs.totalDiscounts.dollars,
      display: `${money(cogs.totalDiscounts.dollars)} · ${cogs.discountPctOfSales}%`,
      source: "Adjusted Cost of Goods",
    });
  }
  if (sales) {
    numbers.push({ key: "cateringSales", label: "Catering sales", value: sales.cateringSales, display: money(sales.cateringSales), source: "Sales Summary" });
  }

  return { period: sales?.period ?? units?.period ?? cogs?.period ?? null, numbers };
}
