import type { ParsedReport, ReportType } from "@/lib/reports";
import { REPORT_LABELS } from "@/lib/reports";
import { averagedReport } from "@/lib/insights";

/** Everything the analyst's tools can read. Built once per run from Postgres. */
export interface AnalystContext {
  restaurant: {
    name: string;
    kind: "FRANCHISE" | "INDEPENDENT";
    brand: string | null;
    radiusMiles: number;
    minCateringOrder: number;
    openingHours: string | null;
  };
  rules: {
    promoApproval: "YES" | "NO" | "UNSURE";
    maxDiscountPct: number;
    allowFreeExtra: boolean;
    allowFreeDelivery: boolean;
    allowPercentOff: boolean;
    allowBogo: boolean;
    useBrandCateringMenu: boolean;
  };
  reports: { report: ParsedReport; status: "READ" | "CONFIRMED" }[];
  pastDecisions: { title: string; status: "APPROVED" | "SKIPPED"; skipReason: string | null; source: string }[];
}

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Human label for where a number came from, e.g. "Day-part report, Aug 26 – Sep 1, 2026",
 * or "Day-part report, weekly average of 6 weeks, Aug 4 – Sep 15, 2026".
 */
export function sourceLabel(report: ParsedReport): string {
  const name = REPORT_LABELS[report.type as ReportType];
  const n = (report as { weeksAveraged?: number }).weeksAveraged;
  const avg = n && n > 1 ? `, weekly average of ${n} weeks` : "";
  if (!report.period) return `${name}${avg}`;
  return `${name}${avg}, ${fmt(report.period.start)} – ${fmt(report.period.end)}`;
}

/**
 * The report of a type for one week (by end date), or, with no week given,
 * a typical week: the average of the latest weeks (up to 8), so one unusual
 * week doesn't decide the offers.
 */
export function pick<T extends ParsedReport["type"]>(ctx: AnalystContext, type: T, week?: string) {
  const all = ctx.reports.map((r) => r.report);
  if (!week) return averagedReport(all, type);
  return all
    .filter((r): r is Extract<ParsedReport, { type: T }> => r.type === type)
    .find((r) => r.period?.end === week || r.period?.start === week);
}

export function weeksOf(ctx: AnalystContext, type: ParsedReport["type"]): string[] {
  return ctx.reports
    .filter((r) => r.report.type === type && r.report.period)
    .map((r) => r.report.period!.end)
    .sort()
    .reverse();
}
