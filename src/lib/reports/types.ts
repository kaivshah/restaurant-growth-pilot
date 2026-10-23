// Shapes produced by the report parsers. Every parser takes a grid of
// cells (string[][]) so CSV and Excel uploads share one code path.

export type Grid = string[][];

export type ReportType =
  | "dayPart"
  | "wisrSales"
  | "wisrUnits"
  | "wisrAdjCogs"
  | "wisrInventoryCategories"
  | "wisrInventoryItems"
  | "wisrBreadOverShort"
  | "cashInWeek";

/** Files we recognise but refuse, because they hold private data we never need. */
export type RejectedType = "laborByEmployee" | "bankStatement";

export interface Period {
  /** ISO date (yyyy-mm-dd) */
  start: string;
  /** ISO date (yyyy-mm-dd) */
  end: string;
}

export interface QtyDollars {
  qty: number;
  dollars: number;
}

export interface DayPartCell {
  units: number;
  sales: number;
  customers: number;
  avgTicket: number;
}

export interface DayPartHour {
  /** Label as printed, e.g. "12PM" */
  label: string;
  /** 0–23 */
  hour24: number;
  byDay: DayPartCell[];
  week: DayPartCell;
}

export interface DayPartReport {
  type: "dayPart";
  storeNumber: string | null;
  period: Period | null;
  /** Day names in column order, e.g. ["Wed", "Thu", …] */
  days: string[];
  hours: DayPartHour[];
  dayTotals: DayPartCell[];
  weekTotal: DayPartCell;
}

export interface WisrSalesReport {
  type: "wisrSales";
  storeNumber: string | null;
  period: Period | null;
  unitSales: number;
  cateringSales: number;
  drinkSales: number;
  miscSales: number;
  netSales: number;
  operatingExpenses: number;
  laborAndTaxes: number;
  costOfGoods: number;
  royalty: number;
  advertisingFund: number;
  localAdvertising: number;
  totalExpenses: number;
  balance: number;
  /** Every line as printed, keyed by its cleaned label */
  lines: Record<string, number>;
}

export interface WisrUnitsReport {
  type: "wisrUnits";
  storeNumber: string | null;
  period: Period | null;
  footlong: number;
  sixInch: number;
  threeInch: number;
  salads: number;
  pizza: number;
  otherUnits: number;
  totalUnits: number;
  customers: number;
  unitsPerCustomer: number;
  drinks: number;
  drinkPct: number;
  averageTicket: number;
  catering: {
    giantSubs: QtyDollars;
    sandwichPlatters: QtyDollars;
    boxedMeals: QtyDollars;
    dessertPlatters: QtyDollars;
  };
}

export interface WisrAdjCogsReport {
  type: "wisrAdjCogs";
  storeNumber: string | null;
  period: Period | null;
  freeUnits: QtyDollars;
  employeeFree: QtyDollars;
  employeeDiscounts: QtyDollars;
  otherDiscounts: QtyDollars;
  valueMealDiscounts: QtyDollars;
  miscDrinkDiscounts: QtyDollars;
  totalDiscounts: QtyDollars;
  discountPctOfSales: number;
  adjustedCogsPct: number;
}

export interface CategoryLine {
  category: string;
  usedDollars: number;
  diffDollars: number | null;
  actualPct: number | null;
  expectedPct: number | null;
  pctDiff: number | null;
}

export interface WisrInventoryCategoriesReport {
  type: "wisrInventoryCategories";
  storeNumber: string | null;
  period: Period | null;
  categories: CategoryLine[];
}

export interface InventoryItemLine {
  item: string;
  isSubtotal: boolean;
  open: number | null;
  delivered: number | null;
  left: number | null;
  used: number | null;
  posDiff: number | null;
  unitCost: number | null;
  usedDollars: number | null;
  diffDollars: number | null;
  actualPct: number | null;
  expectedPct: number | null;
  pctDiff: number | null;
}

export interface WisrInventoryItemsReport {
  type: "wisrInventoryItems";
  storeNumber: string | null;
  period: Period | null;
  items: InventoryItemLine[];
}

export interface BreadOverShortDay {
  day: string;
  cash: number;
  bread: number;
}

export interface WisrBreadOverShortReport {
  type: "wisrBreadOverShort";
  storeNumber: string | null;
  period: Period | null;
  days: BreadOverShortDay[];
  total: { cash: number; bread: number } | null;
}

export interface CashInWeekDay {
  date: string;
  netSales: number;
}

export interface CashInWeekReport {
  type: "cashInWeek";
  storeNumber: string | null;
  period: Period | null;
  days: CashInWeekDay[];
}

export type ParsedReport =
  | DayPartReport
  | WisrSalesReport
  | WisrUnitsReport
  | WisrAdjCogsReport
  | WisrInventoryCategoriesReport
  | WisrInventoryItemsReport
  | WisrBreadOverShortReport
  | CashInWeekReport;

export type ParseResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; reason: "rejected"; rejectedType: RejectedType; message: string }
  | { ok: false; reason: "unrecognised" | "unreadable"; message: string };
