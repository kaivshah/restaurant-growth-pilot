import {
  cleanLabel,
  findRow,
  isBlankRow,
  monthDayYearToIso,
  num,
  num0,
  readWisrHeader,
  usDateToIso,
} from "./cells";
import type {
  CashInWeekReport,
  CategoryLine,
  DayPartCell,
  DayPartHour,
  DayPartReport,
  Grid,
  InventoryItemLine,
  QtyDollars,
  WisrAdjCogsReport,
  WisrBreadOverShortReport,
  WisrInventoryCategoriesReport,
  WisrInventoryItemsReport,
  WisrSalesReport,
  WisrUnitsReport,
} from "./types";

export class ReportFormatError extends Error {}

function cellAt(row: string[], start: number): DayPartCell {
  return {
    units: num0(row[start]),
    sales: num0(row[start + 1]),
    customers: num0(row[start + 2]),
    avgTicket: num0(row[start + 3]),
  };
}

/** "7AM" → 7, "12PM" → 12, "12AM" → 0, "1PM" → 13 */
function hourLabelTo24(label: string): number | null {
  const m = label.trim().toUpperCase().match(/^(\d{1,2})\s*(AM|PM)$/);
  if (!m) return null;
  const h = Number(m[1]) % 12;
  return m[2] === "PM" ? h + 12 : h;
}

/**
 * Day Part / Hourly Sales & Units Breakdown.
 * Columns: Hour, then 4 cells (Units, Sales, Cust, Avg Ticket) per day for
 * 7 days, then Week Total (4) and Week Avg (4). "Total" rows are day-part
 * subtotals and are skipped; "Totals" is the grand total.
 */
export function parseDayPart(grid: Grid): DayPartReport {
  const storeLine = grid.find((r) => /^Store:/i.test(r[0] ?? ""))?.[0] ?? "";
  const storeNumber = storeLine.match(/\((\d+)\)/)?.[1] ?? null;

  const rangeLine = grid.find((r) => /^Date Range:/i.test(r[0] ?? ""))?.[0] ?? "";
  const range = rangeLine.replace(/^Date Range:\s*/i, "").split(/\s+-\s+/);
  const start = range[0] ? monthDayYearToIso(range[0]) : null;
  const end = range[1] ? monthDayYearToIso(range[1]) : null;

  const metricRowIdx = grid.findIndex((r) => (r[0] ?? "").toLowerCase() === "hour");
  if (metricRowIdx < 1) throw new ReportFormatError("Could not find the Hour header row.");
  const dayRow = grid[metricRowIdx - 1];

  const days: string[] = [];
  for (let c = 1; c + 3 < dayRow.length; c += 4) {
    const name = dayRow[c];
    if (!name || /^week/i.test(name)) break;
    days.push(name);
  }
  if (days.length === 0) throw new ReportFormatError("Could not find day columns.");
  const weekTotalCol = 1 + days.length * 4;

  const hours: DayPartHour[] = [];
  let totalsRow: string[] | undefined;
  for (const row of grid.slice(metricRowIdx + 1)) {
    const label = row[0] ?? "";
    if (label.toLowerCase() === "totals") {
      totalsRow = row;
      continue;
    }
    const hour24 = hourLabelTo24(label);
    if (hour24 === null) continue; // "Total" subtotals and blank lines
    hours.push({
      label,
      hour24,
      byDay: days.map((_, i) => cellAt(row, 1 + i * 4)),
      week: cellAt(row, weekTotalCol),
    });
  }
  if (!totalsRow) throw new ReportFormatError("Could not find the Totals row.");
  const totals = totalsRow;

  return {
    type: "dayPart",
    storeNumber,
    period: start && end ? { start, end } : null,
    days,
    hours: hours.sort((a, b) => a.hour24 - b.hour24),
    dayTotals: days.map((_, i) => cellAt(totals, 1 + i * 4)),
    weekTotal: cellAt(totals, weekTotalCol),
  };
}

/** Read "LABEL","value","%" lines into a map keyed by the cleaned, upper-cased label. */
function labelValueMap(grid: Grid, valueCol = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of grid) {
    const label = cleanLabel(row[0]).toUpperCase();
    const value = num(row[valueCol]);
    if (label && value !== null) out[label] = value;
  }
  return out;
}

function need(map: Record<string, number>, key: string): number {
  const v = map[key];
  if (v === undefined) throw new ReportFormatError(`Missing line "${key}".`);
  return v;
}

export function parseWisrSales(grid: Grid): WisrSalesReport {
  const lines = labelValueMap(grid);
  return {
    type: "wisrSales",
    ...readWisrHeader(grid),
    unitSales: need(lines, "UNIT SALES"),
    cateringSales: need(lines, "CATERING SALES"),
    drinkSales: need(lines, "DRINK SALES"),
    miscSales: lines["MISC SALES"] ?? 0,
    netSales: need(lines, "NET SUBWAY SALES"),
    operatingExpenses: lines["OPERATING EXPENSES"] ?? 0,
    laborAndTaxes: lines["LABOR & TAXES"] ?? 0,
    costOfGoods: lines["COST OF GOODS"] ?? 0,
    royalty: lines["ROYALTY"] ?? 0,
    advertisingFund: lines["FAF"] ?? 0,
    localAdvertising: lines["LOCAL ADVERTISING"] ?? 0,
    totalExpenses: lines["TOTAL EXPENSES"] ?? 0,
    balance: lines["BALANCE"] ?? 0,
    lines,
  };
}

function qtyDollars(grid: Grid, label: string, qtyCol = 1, dollarCol = 2): QtyDollars {
  const row = findRow(grid, label);
  return { qty: num0(row?.[qtyCol]), dollars: num0(row?.[dollarCol]) };
}

export function parseWisrUnits(grid: Grid): WisrUnitsReport {
  const qty = labelValueMap(grid, 1);
  const second = labelValueMap(grid, 2);
  return {
    type: "wisrUnits",
    ...readWisrHeader(grid),
    footlong: need(qty, "FOOTLONG (30CM)"),
    sixInch: need(qty, "6 INCH (15CM)"),
    threeInch: qty["3 INCH (7.5CM)/MUFFIN"] ?? 0,
    salads: qty["SALADS"] ?? 0,
    pizza: qty["PIZZA"] ?? 0,
    otherUnits: qty["OTHER UNITS"] ?? 0,
    totalUnits: need(qty, "TOTAL UNITS"),
    customers: need(qty, "CUSTOMER COUNT-UNITS/CUST"),
    unitsPerCustomer: second["CUSTOMER COUNT-UNITS/CUST"] ?? 0,
    drinks: qty["DRINKS - DRINK PCT"] ?? 0,
    drinkPct: second["DRINKS - DRINK PCT"] ?? 0,
    averageTicket: need(qty, "AVERAGE TICKET"),
    catering: {
      giantSubs: qtyDollars(grid, "GIANT SUBS"),
      sandwichPlatters: qtyDollars(grid, "SANDWICH PLATTERS"),
      boxedMeals: qtyDollars(grid, "BOXED MEALS"),
      dessertPlatters: qtyDollars(grid, "DESSERT PLATTERS"),
    },
  };
}

export function parseWisrAdjCogs(grid: Grid): WisrAdjCogsReport {
  const pctRow = (label: string) => {
    const row = findRow(grid, label);
    if (!row) throw new ReportFormatError(`Missing line "${label}".`);
    return num0(row[3]);
  };
  const total = qtyDollars(grid, "TOTAL DISCOUNT VALUE");
  if (!findRow(grid, "TOTAL DISCOUNT VALUE")) {
    throw new ReportFormatError('Missing line "TOTAL DISCOUNT VALUE".');
  }
  return {
    type: "wisrAdjCogs",
    ...readWisrHeader(grid),
    freeUnits: qtyDollars(grid, "FREE UNITS"),
    employeeFree: qtyDollars(grid, "EMPLOYEE FREE"),
    employeeDiscounts: qtyDollars(grid, "EMPLOYEE DISCOUNTS"),
    otherDiscounts: qtyDollars(grid, "OTHER DISCOUNT VALUE"),
    valueMealDiscounts: qtyDollars(grid, "FVM DISCOUNTS VALUE"),
    miscDrinkDiscounts: qtyDollars(grid, "MISC & DRINK DISC VALUE"),
    totalDiscounts: total,
    discountPctOfSales: pctRow("DISCOUNT VALUE % OF SALES"),
    adjustedCogsPct: pctRow("ADJUSTED COST OF GOODS"),
  };
}

export function parseWisrInventoryCategories(grid: Grid): WisrInventoryCategoriesReport {
  const headerIdx = grid.findIndex((r) => cleanLabel(r[0]).toUpperCase() === "CATEGORY SUMMARY");
  if (headerIdx < 0) throw new ReportFormatError("Could not find CATEGORY SUMMARY.");
  const categories: CategoryLine[] = [];
  for (const row of grid.slice(headerIdx + 1)) {
    if (isBlankRow(row)) continue;
    const used = num(row[1]);
    if (used === null) continue;
    categories.push({
      category: cleanLabel(row[0]),
      usedDollars: used,
      diffDollars: num(row[2]),
      actualPct: num(row[3]),
      expectedPct: num(row[4]),
      pctDiff: num(row[5]),
    });
  }
  return { type: "wisrInventoryCategories", ...readWisrHeader(grid), categories };
}

/**
 * Inventory Items. Header:
 *   OPEN, +DEL, -LEFT, =USED, POS DIFF, RW, COST, Item, $ =USED, $ DIFF, ACT %, EXP %, % DIFF
 * Item names arrive wrapped in extra quotes. Sub-total rows have no counts.
 * Trailing lines (DELIVERY FEE, DISTRIBUTOR CREDITS…) use a different layout and are skipped.
 */
export function parseWisrInventoryItems(grid: Grid): WisrInventoryItemsReport {
  const headerIdx = grid.findIndex((r) => r.some((c) => c === "Item") && r.some((c) => cleanLabel(c) === "DEL"));
  if (headerIdx < 0) throw new ReportFormatError("Could not find the inventory header row.");
  const header = grid[headerIdx].map((c) => cleanLabel(c).toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const c = {
    open: col("OPEN"), del: col("DEL"), left: col("LEFT"), used: col("USED"),
    posDiff: col("POS DIFF"), cost: col("COST"), item: col("ITEM"),
    usedDollars: col("$ =USED"), diffDollars: col("$ DIFF"),
    act: col("ACT %"), exp: col("EXP %"), pctDiff: col("% DIFF"),
  };
  const items: InventoryItemLine[] = [];
  for (const row of grid.slice(headerIdx + 1)) {
    const name = cleanLabel(row[c.item]);
    if (!name) continue;
    const isSubtotal = /sub\s*total|^units total$|^drinks total$|^misc total$|^other total$/i.test(name) || /summary$/i.test(name);
    items.push({
      item: name,
      isSubtotal,
      open: num(row[c.open]),
      delivered: num(row[c.del]),
      left: num(row[c.left]),
      used: num(row[c.used]),
      posDiff: num(row[c.posDiff]),
      unitCost: num(row[c.cost]),
      usedDollars: num(row[c.usedDollars]),
      diffDollars: num(row[c.diffDollars]),
      actualPct: num(row[c.act]),
      expectedPct: num(row[c.exp]),
      pctDiff: num(row[c.pctDiff]),
    });
  }
  return { type: "wisrInventoryItems", ...readWisrHeader(grid), items };
}

export function parseWisrBreadOverShort(grid: Grid): WisrBreadOverShortReport {
  const headerIdx = grid.findIndex((r) => r[0] === "Cash" && r[1] === "Day" && r[2] === "Bread");
  if (headerIdx < 0) throw new ReportFormatError("Could not find the Cash / Day / Bread header.");
  const days: WisrBreadOverShortReport["days"] = [];
  let total: WisrBreadOverShortReport["total"] = null;
  for (const row of grid.slice(headerIdx + 1)) {
    if (isBlankRow(row) || !row[1]) continue;
    const entry = { cash: num0(row[0]), bread: num0(row[2]) };
    if (row[1].toLowerCase() === "total") total = entry;
    else days.push({ day: row[1], ...entry });
  }
  return { type: "wisrBreadOverShort", ...readWisrHeader(grid), days, total };
}

/** Cash In Week: we only take the first table (one row per day with Net Sales). */
export function parseCashInWeek(grid: Grid): CashInWeekReport {
  const headerIdx = grid.findIndex((r) => r[0] === "Date" && r.includes("Net Sales"));
  if (headerIdx < 0) throw new ReportFormatError("Could not find the Date / Net Sales header.");
  const salesCol = grid[headerIdx].indexOf("Net Sales");
  const days: CashInWeekReport["days"] = [];
  for (const row of grid.slice(headerIdx + 1)) {
    if (isBlankRow(row)) break;
    const date = usDateToIso(row[0] ?? "");
    const sales = num(row[salesCol]);
    if (date && sales !== null) days.push({ date, netSales: sales });
  }
  const sorted = days.map((d) => d.date).sort();
  return {
    type: "cashInWeek",
    storeNumber: null,
    period: sorted.length ? { start: sorted[0], end: sorted[sorted.length - 1] } : null,
    days,
  };
}
