import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { csvToGrid, hasCell } from "./cells";
import {
  parseCashInWeek,
  parseDayPart,
  parseExtraTable,
  parseWisrAdjCogs,
  parseWisrBreadOverShort,
  parseWisrInventoryCategories,
  parseWisrInventoryItems,
  parseWisrSales,
  parseWisrUnits,
  ReportFormatError,
} from "./parsers";
import type { Grid, ParsedReport, ParseResult, ReportType } from "./types";

export * from "./types";
export { summarise } from "./summary";
export * from "./weeks";

export const REPORT_LABELS: Record<ReportType, string> = {
  dayPart: "Day Part / Hourly Sales & Units",
  wisrSales: "WISR Sales Summary",
  wisrUnits: "WISR Units Summary",
  wisrAdjCogs: "WISR Adjusted Cost of Goods",
  wisrInventoryCategories: "WISR Inventory Categories",
  wisrInventoryItems: "WISR Inventory Items",
  wisrBreadOverShort: "WISR Daily Cash / Bread Over-Short",
  cashInWeek: "Cash In Week",
  extraTable: "Other report",
};

/** The four reports a store needs before recommendations can start. */
export const REQUIRED_REPORTS: ReportType[] = ["dayPart", "wisrSales", "wisrUnits", "wisrAdjCogs"];

export function detectReportType(grid: Grid): Exclude<ReportType, "extraTable"> | "laborByEmployee" | null {
  const first = (grid[0]?.[0] ?? "").replace(/^﻿/, "");
  // Payroll journals and staff schedules hold pay, addresses and names: refused like labor files.
  if (/^Payroll Journal Report/i.test(first) || hasCell(grid, "Employee Earnings")) return "laborByEmployee";
  if (grid.slice(0, 3).some((r) => r.some((c) => /Employee Weekly Schedule/i.test(c)))) return "laborByEmployee";
  if (/^Day Part\/Hourly Sales/i.test(first)) return "dayPart";
  if (/^Cash In Week Report/i.test(first)) return "cashInWeek";
  const header = grid[0] ?? [];
  if (header.includes("Clerk ID") && header.includes("Name")) return "laborByEmployee";
  if (hasCell(grid, "SALES SUMMARY")) return "wisrSales";
  if (hasCell(grid, "UNITS SUMMARY")) return "wisrUnits";
  if (hasCell(grid, "ADJ COST OF GOODS")) return "wisrAdjCogs";
  if (hasCell(grid, "CATEGORY SUMMARY")) return "wisrInventoryCategories";
  if (grid.some((r) => r.includes("Item") && r.some((c) => c.replace(/^'/, "") === "+DEL"))) {
    return "wisrInventoryItems";
  }
  if (grid.some((r) => r.some((c) => /OVER \/ SHORT/i.test(c)))) return "wisrBreadOverShort";
  return null;
}

export function parseGrid(grid: Grid): ParseResult {
  const type = detectReportType(grid);
  if (type === "laborByEmployee") {
    return {
      ok: false,
      reason: "rejected",
      rejectedType: "laborByEmployee",
      message: "This file has employee names, hours or pay. We don't need it, so we haven't kept it.",
    };
  }
  if (!type) {
    return {
      ok: false,
      reason: "unrecognised",
      message: "We don't recognise this report yet. Check it's a WISR or day-part export.",
    };
  }
  try {
    const report: ParsedReport = (() => {
      switch (type) {
        case "dayPart": return parseDayPart(grid);
        case "wisrSales": return parseWisrSales(grid);
        case "wisrUnits": return parseWisrUnits(grid);
        case "wisrAdjCogs": return parseWisrAdjCogs(grid);
        case "wisrInventoryCategories": return parseWisrInventoryCategories(grid);
        case "wisrInventoryItems": return parseWisrInventoryItems(grid);
        case "wisrBreadOverShort": return parseWisrBreadOverShort(grid);
        case "cashInWeek": return parseCashInWeek(grid);
      }
    })();
    return { ok: true, report };
  } catch (err) {
    if (err instanceof ReportFormatError) {
      return { ok: false, reason: "unreadable", message: `This looks like a ${REPORT_LABELS[type]}, but ${err.message}` };
    }
    throw err;
  }
}

async function excelToGrid(buffer: ArrayBuffer): Promise<Grid> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const grid: Grid = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cell.text?.trim() ?? "";
    });
    grid[rowNumber - 1] = Array.from(cells, (c) => c ?? "");
  });
  return Array.from(grid, (r) => r ?? []);
}

/** Parse an uploaded file by name and contents. PDFs are not read yet. */
export async function parseReportFile(fileName: string, data: ArrayBuffer): Promise<ParseResult> {
  const lower = fileName.toLowerCase();
  let grid: Grid | null = null;
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) grid = csvToGrid(new TextDecoder("utf-8").decode(data));
  if (lower.endsWith(".xlsx")) {
    try {
      grid = await excelToGrid(data);
    } catch {
      return { ok: false, reason: "unreadable", message: "We couldn't open this Excel file." };
    }
  }
  if (grid) {
    const known = parseGrid(grid);
    if (known.ok || known.reason !== "unrecognised") return known;
    // Not a report we know: keep it as a small table, unless it holds personal details.
    const extra = parseExtraTable(grid, fileName);
    if (extra === "private") {
      return { ok: false, reason: "rejected", rejectedType: "laborByEmployee", message: "This file has names, contact or pay details. We don't need them, so we haven't kept it." };
    }
    return extra ? { ok: true, report: extra } : known;
  }
  if (lower.endsWith(".pdf")) {
    return {
      ok: false,
      reason: "unreadable",
      message: "PDF reports aren't supported yet. Please export the same report as CSV or Excel.",
    };
  }
  return { ok: false, reason: "unrecognised", message: "Upload a CSV, Excel (.xlsx) or PDF file." };
}

/** Most files and bytes we unpack from one zip (WISR bundles hold six small CSVs). */
const ZIP_LIMITS = { files: 30, bytes: 10 * 1024 * 1024 };

/**
 * The files inside an upload: a WISR zip is unpacked into its reports, any
 * other file is returned as is. Folders, hidden files and anything that isn't
 * CSV or Excel are skipped.
 */
export function expandUpload(fileName: string, data: ArrayBuffer): { name: string; data: ArrayBuffer }[] | { error: string } {
  if (!fileName.toLowerCase().endsWith(".zip")) return [{ name: fileName, data }];
  let total = 0;
  let count = 0;
  try {
    const files = unzipSync(new Uint8Array(data), {
      filter: (f) => {
        const base = f.name.split("/").pop() ?? "";
        const wanted = !base.startsWith(".") && !f.name.startsWith("__MACOSX") && /\.(csv|txt|xlsx)$/i.test(base);
        if (!wanted) return false;
        count++;
        total += f.originalSize;
        return count <= ZIP_LIMITS.files && total <= ZIP_LIMITS.bytes;
      },
    });
    if (count > ZIP_LIMITS.files || total > ZIP_LIMITS.bytes) return { error: "This zip is too big. Upload the weekly WISR export as it comes." };
    const out = Object.entries(files).map(([name, bytes]) => ({ name: name.split("/").pop()!, data: bytes.slice().buffer as ArrayBuffer }));
    return out.length ? out : { error: "This zip has no CSV or Excel reports in it." };
  } catch {
    return { error: "We couldn't open this zip file." };
  }
}
