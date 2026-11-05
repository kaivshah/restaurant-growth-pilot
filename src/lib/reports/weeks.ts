import type { ReportType } from "./types";

/**
 * Reports are uploaded a week at a time, in two groups: the Day Part export,
 * and the WISR export (a zip with six reports). Four weeks of each are needed
 * to start; up to eight are kept, since every extra week is more for the AI to
 * read.
 */
export const MIN_WEEKS = 4;
export const MAX_WEEKS = 8;

export type UploadGroup = "dayPart" | "wisr" | "other";

export const GROUP_TYPES: Record<UploadGroup, ReportType[]> = {
  dayPart: ["dayPart"],
  wisr: ["wisrSales", "wisrUnits", "wisrAdjCogs", "wisrInventoryItems", "wisrInventoryCategories", "wisrBreadOverShort"],
  other: ["cashInWeek", "extraTable"],
};

/** Most optional files (Cash In Week weeks and other exports) kept, for the same reason. */
export const MAX_EXTRA_FILES = 8;

/** The WISR reports a week needs before it counts. */
export const WISR_REQUIRED: ReportType[] = ["wisrSales", "wisrUnits", "wisrAdjCogs"];

export const GROUP_NAMES: Record<UploadGroup, string> = { dayPart: "Day Part Sales", wisr: "WISR", other: "Other reports" };

export function groupOf(type: ReportType): UploadGroup {
  return (Object.keys(GROUP_TYPES) as UploadGroup[]).find((g) => GROUP_TYPES[g].includes(type)) ?? "other";
}

export interface WeekRow {
  /** yyyy-mm-dd of the week's last day */
  end: string;
  start: string | null;
  /** The reports of this group uploaded for this week */
  types: ReportType[];
  fileNames: string[];
  /** For WISR: the required reports still missing this week */
  missing: ReportType[];
  flagged: boolean;
}

/** One group's weeks, oldest first (Week 1 is the earliest). */
export function weeksOf(group: UploadGroup, uploads: { reportType: string; periodStart: Date | null; periodEnd: Date | null; fileName: string; status: string }[]): WeekRow[] {
  const byEnd = new Map<string, WeekRow>();
  for (const u of uploads) {
    if (!u.periodEnd || !GROUP_TYPES[group].includes(u.reportType as ReportType)) continue;
    const end = u.periodEnd.toISOString().slice(0, 10);
    const row = byEnd.get(end) ?? { end, start: u.periodStart?.toISOString().slice(0, 10) ?? null, types: [], fileNames: [], missing: [], flagged: false };
    if (!row.types.includes(u.reportType as ReportType)) row.types.push(u.reportType as ReportType);
    if (!row.fileNames.includes(u.fileName.split(" › ")[0])) row.fileNames.push(u.fileName.split(" › ")[0]);
    if (u.status === "FLAGGED") row.flagged = true;
    byEnd.set(end, row);
  }
  const rows = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  if (group === "wisr") for (const r of rows) r.missing = WISR_REQUIRED.filter((t) => !r.types.includes(t));
  return rows;
}

/** Weeks that count towards the four needed: complete and not marked wrong. */
export const completeWeeks = (rows: WeekRow[]) => rows.filter((r) => !r.flagged && r.missing.length === 0);
