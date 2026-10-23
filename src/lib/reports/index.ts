import ExcelJS from "exceljs";
import { csvToGrid, hasCell } from "./cells";
import {
  parseCashInWeek,
  parseDayPart,
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

export const REPORT_LABELS: Record<ReportType, string> = {
  dayPart: "Day Part / Hourly Sales & Units",
  wisrSales: "WISR Sales Summary",
  wisrUnits: "WISR Units Summary",
  wisrAdjCogs: "WISR Adjusted Cost of Goods",
  wisrInventoryCategories: "WISR Inventory Categories",
  wisrInventoryItems: "WISR Inventory Items",
  wisrBreadOverShort: "WISR Daily Cash / Bread Over-Short",
  cashInWeek: "Cash In Week",
};

/** The four reports a store needs before recommendations can start. */
export const REQUIRED_REPORTS: ReportType[] = ["dayPart", "wisrSales", "wisrUnits", "wisrAdjCogs"];

export function detectReportType(grid: Grid): ReportType | "laborByEmployee" | null {
  const first = (grid[0]?.[0] ?? "").replace(/^﻿/, "");
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
      message: "This file lists employee names and hours. We don't need it, so we haven't kept it.",
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
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return parseGrid(csvToGrid(new TextDecoder("utf-8").decode(data)));
  }
  if (lower.endsWith(".xlsx")) {
    try {
      return parseGrid(await excelToGrid(data));
    } catch {
      return { ok: false, reason: "unreadable", message: "We couldn't open this Excel file." };
    }
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
