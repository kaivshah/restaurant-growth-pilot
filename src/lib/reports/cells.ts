import Papa from "papaparse";
import type { Grid, Period } from "./types";

/** Parse CSV text into a grid of trimmed cells. Handles BOMs and CRLF. */
export function csvToGrid(text: string): Grid {
  const clean = text.replace(/^﻿/, "");
  const result = Papa.parse<string[]>(clean, { skipEmptyLines: false });
  return result.data.map((row) => row.map((cell) => (cell ?? "").trim()));
}

/** Strip the decorations WISR reports put in front of labels: quotes, "'+ ", "'= ", "'- ". */
export function cleanLabel(cell: string | undefined): string {
  return (cell ?? "")
    .replace(/^"+|"+$/g, "")
    .replace(/^'+/, "")
    .replace(/^[+=-]\s*/, "")
    .trim();
}

/** Parse "1,234.50", "$12", "38%", "-7.12" → number. Empty or invalid → null. */
export function num(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const s = cell.replace(/[$,%\s]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Like num(), but treats empty as 0. Use for cells that should always hold a number. */
export function num0(cell: string | undefined): number {
  return num(cell) ?? 0;
}

export function isBlankRow(row: string[]): boolean {
  return row.every((c) => c === "");
}

/** Find the first row whose first cell (cleaned, case-insensitive) equals label. */
export function findRow(grid: Grid, label: string): string[] | undefined {
  const target = label.toUpperCase();
  return grid.find((row) => cleanLabel(row[0]).toUpperCase() === target);
}

/** Does any cell in the grid (cleaned) equal this label? */
export function hasCell(grid: Grid, label: string): boolean {
  const target = label.toUpperCase();
  return grid.some((row) => row.some((c) => cleanLabel(c).toUpperCase() === target));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "8/18/2026" → "2026-08-18" */
export function usDateToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Aug 26 2026" → "2026-08-26" */
export function monthDayYearToIso(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${pad(month)}-${pad(Number(m[2]))}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * WISR files start with:
 *   "Store:","32105",
 *   "Week ending:","8/18/2026"
 * A WISR week is the 7 days ending on the week-ending date.
 */
export function readWisrHeader(grid: Grid): { storeNumber: string | null; period: Period | null } {
  const store = findRow(grid, "Store:");
  const week = findRow(grid, "Week ending:");
  const end = week ? usDateToIso(week[1] ?? "") : null;
  return {
    storeNumber: store?.[1] ? store[1] : null,
    period: end ? { start: addDaysIso(end, -6), end } : null,
  };
}
