/**
 * Writes made-up reports to fixtures/sample/ in the exact layout of the
 * Subway back-office exports. The numbers are invented (store 00000), so
 * they are safe to commit. Run: npx tsx scripts/make-sample-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(process.cwd(), "fixtures", "sample");
mkdirSync(out, { recursive: true });

const q = (cells: (string | number)[]) => cells.map((c) => `"${c}"`).join(",");
const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";

function wisr(name: string, rows: string[]) {
  const head = `"Store:","00000",\n"Week ending:","3/10/2026"\n\n`;
  writeFileSync(join(out, name), head + crlf(rows));
}

wisr("SalesSummary_00000_3-10-2026.csv", [
  q(["'SALES SUMMARY", "$", "%"]),
  q(["'+ UNIT SALES", 5000, 80]),
  q(["'+ CATERING SALES", 250, 4]),
  q(["'+ DRINK SALES", 600, 10]),
  q(["'+ MISC SALES", 400, 6]),
  q(["'= NET SUBWAY SALES", 6250, 100]),
  q(["'RENT", 1000, 16]),
  q(["'= OPERATING EXPENSES", 1500, 24]),
  q(["'+ LABOR & TAXES", 1900, 30]),
  q(["'+ COST OF GOODS", 1400, 22]),
  q(["'+ ROYALTY", "500.00", 8]),
  q(["'+ FAF", "281.25", 5]),
  q(["'+ LOCAL ADVERTISING", 50, 1]),
  q(["'= TOTAL EXPENSES", 5631, 90]),
  q(["'= BALANCE", 619, 10]),
  `"-OTHER EXPENSES", , ,`,
]);

wisr("UnitsSummary_00000_3-10-2026.csv", [
  q(["UNITS SUMMARY", "Qty", "%"]),
  q(["FOOTLONG (30cm)", 300, 60]),
  q(["6 INCH (15cm)", 180, 36]),
  q(["3 INCH (7.5cm)/MUFFIN", 0, 0]),
  q(["SALADS", 10, 2]),
  q(["PIZZA", 0, 0]),
  q(["OTHER UNITS", 10, 2]),
  q(["TOTAL UNITS", 500, 100]),
  q(["CUSTOMER COUNT-UNITS/CUST", 450, "1.1"]),
  q(["DRINKS - DRINK PCT", 225, 50]),
  q(["FACTOR", "9.50", ""]),
  q(["AVERAGE TICKET", "12.50", ""]),
  q(["CATERING SUMMARY", "Qty", "$"]),
  q(["GIANT SUBS", 1, 60]),
  q(["SANDWICH PLATTERS", 2, 150]),
  q(["BOXED MEALS", 4, 40]),
  q(["DESSERT PLATTERS", 0, 0]),
]);

wisr("AdjustedCostOfGoods_00000_3-10-2026.csv", [
  q(["ADJ COST OF GOODS", "Qty", "$", "%"]),
  q(["FREE UNITS", 40, 400, 40]),
  q(["EMPLOYEE FREE", 0, 0, 0]),
  q(["EMPLOYEE DISCOUNTS", 5, 25, 3]),
  q(["OTHER DISCOUNT VALUE", 100, 300, 30]),
  q(["FVM DISCOUNTS VALUE", 90, 270, 27]),
  q(["MISC & DRINK DISC VALUE", 5, 5, 0]),
  q(["TOTAL DISCOUNT VALUE", 240, 1000, 100]),
  q(["DISCOUNT VALUE % OF SALES", "", "", "16.0"]),
  q(["ADJUSTED COST OF GOODS", "", "", "19.5"]),
]);

wisr("InventoryCategoriesSummary_00000_3-10-2026.csv", [
  q(["CATEGORY SUMMARY", "$ USED", "$ DIFF", "ACT %", "EXP %", "% DIFF"]),
  q(["CHEESE", 150, -10, "3.0", "2.8", "-0.2"]),
  q(["MEAT/PROTEIN", 500, 15, "10.0", "10.3", "0.3"]),
  q(["VEGGIES", 200, -80, "4.0", "2.4", "-1.6"]),
  q(["TOPPINGS", 90, -30, "1.8", "1.2", "-0.6"]),
  q(["COST OF GOODS", 1400, -105, "22.4", "20.7", "-1.7"]),
  q(["DISTRIBUTION COST", -20, "", "-1", "", ""]),
]);

wisr("InventoryItems_00000_3-10-2026.csv", [
  q(["OPEN ", "'+DEL", "'-LEFT", "'=USED", "POS DIFF", "RW", "COST", "Item", "$ =USED", "$ DIFF", "ACT %", "EXP %", "% DIFF"]),
  `"50.0","40.0","45.0","45.0","-5.0","0.0","2.50","""Cheese, Sliced cheese""","112","-12","2.2","2.0","-0.2"`,
  `"","","","45.0","-5.0","0.0","","""Cheese Sub Total""","112","-12","2.2","2.0","-0.2"`,
  `"20.0","10.0","12.0","18.0","4.0","0.0","4.00","""Turkey""","72","16","1.4","1.7","0.3"`,
  `"300.0","200.0","150.0","350.0","-60.0","0.0","0.70","""Chips""","245","-42","30.0","25.0","-5.0"`,
  `"","","","","","","","""Units Total""","429","-38","8.6","7.8","-0.8"`,
  `"","","","","","","","DELIVERY FEE","0","","0","",""`,
]);

wisr("DailyCashBreadOverShort_00000_3-10-2026.csv", [
  q(["", "+/- OVER / SHORT", ""]),
  q(["Cash", "Day", "Bread"]),
  q(["1.00", "Wed", "-5.00"]),
  q(["-2.00", "Thu", "10.00"]),
  q(["0.50", "Fri", "0.00"]),
  q(["0.00", "Sat", "20.00"]),
  q(["-1.00", "Sun", "100.00"]),
  q(["0.00", "Mon", "50.00"]),
  q(["1.50", "Tue", "-2.00"]),
  q(["0.00", "Total", "173.00"]),
]);

// Day part: sales per hour follow a lunch-peaked curve; one customer per unit.
const days = ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"];
const hourSales: Record<string, number> = {
  "7AM": 0, "8AM": 0, "9AM": 20, "10AM": 100, "11AM": 300, "12PM": 600, "1PM": 550,
  "2PM": 400, "3PM": 250, "4PM": 200, "5PM": 220, "6PM": 260, "7PM": 240, "8PM": 180,
  "9PM": 90, "10PM": 0, "11PM": 0, "12AM": 0, "1AM": 0, "2AM": 0, "3AM": 0, "4AM": 0,
  "5AM": 0, "6AM": 0,
};
const dayFactor = [1.2, 1.1, 1.1, 0.8, 0.7, 1.0, 1.1];
const groups = [
  ["7AM", "8AM", "9AM", "10AM", "11AM"],
  ["12PM", "1PM", "2PM"],
  ["3PM", "4PM", "5PM"],
  ["6PM", "7PM", "8PM"],
  ["9PM", "10PM", "11PM", "12AM"],
  ["1AM", "2AM", "3AM", "4AM", "5AM", "6AM"],
];
type Cell = { u: number; s: number; c: number };
const cellFor = (hour: string, d: number): Cell => {
  const s = Math.round(hourSales[hour] * dayFactor[d]);
  const u = Math.round(s / 10);
  return { u, s, c: u };
};
const fmt = (x: Cell) => [x.u, x.s.toFixed(2), x.c, x.c ? (x.s / x.c).toFixed(2) : "0.00"];
const sum = (cells: Cell[]): Cell => cells.reduce((a, b) => ({ u: a.u + b.u, s: a.s + b.s, c: a.c + b.c }), { u: 0, s: 0, c: 0 });
const rowFor = (label: string, perDay: Cell[]) => {
  const week = sum(perDay);
  const avg = { u: Math.round(week.u / 7), s: week.s / 7, c: Math.round(week.c / 7) };
  return q([label, ...perDay.flatMap(fmt), ...fmt(week), avg.u, avg.s.toFixed(2), avg.c, week.c ? (week.s / week.c).toFixed(2) : "0.00"]);
};
const lines = [
  q(["Day Part/Hourly Sales & Units Breakdown"]),
  q(["Store: Sampletown, CA(00000)"]),
  q(["Date Range:  Mar 4 2026 - Mar 10 2026"]),
  q(["Order Source Type:All Types"]),
  "",
  "," + q([...days.flatMap((d) => [d, d, d, d]), ...Array(4).fill("Week Total"), ...Array(4).fill("Week Avg")]),
  q(["Hour", ...Array(9).fill(["Units", "Sales", "Cust", "Avg Ticket"]).flat()]) + ",",
];
const allPerDay: Cell[][] = days.map(() => []);
for (const group of groups) {
  const groupPerDay: Cell[][] = days.map(() => []);
  for (const hour of group) {
    const perDay = days.map((_, d) => cellFor(hour, d));
    perDay.forEach((cell, d) => { groupPerDay[d].push(cell); allPerDay[d].push(cell); });
    lines.push(rowFor(hour, perDay));
  }
  lines.push(rowFor("Total", groupPerDay.map(sum)));
}
lines.push(rowFor("Totals", allPerDay.map(sum)));
writeFileSync(join(out, "DayPartSalesAndUnitsReport20260304.csv"), "﻿" + crlf(lines));

writeFileSync(
  join(out, "LaborHoursbyEmployee.csv"),
  crlf([q(["Store Number", "Clerk ID", "Name", "Date", "Hours", "Tips"]), q(["00000", "1", "Sample, Person", "March 4 2026", "8", "0.00"])]),
);

console.log(`Wrote sample fixtures to ${out}`);
