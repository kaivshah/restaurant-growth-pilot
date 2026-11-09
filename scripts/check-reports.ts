/**
 * Shows, for each store, every uploaded report and what the AI actually reads
 * from them: how many weeks each report's numbers are averaged over, and the
 * sources the AI is given. No AI is called. Run: npm run reports:check
 */
import { loadEnv } from "./env";

async function main() {
  loadEnv();
  const { db } = await import("@/lib/db");
  const { coverage } = await import("@/lib/insights");
  const { REPORT_LABELS } = await import("@/lib/reports");
  const { buildContext } = await import("@/lib/analyst");
  const { TOOLS_BY_NAME } = await import("@/lib/analyst/tools");
  type ParsedReport = import("@/lib/reports").ParsedReport;
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no date");

  for (const r of await db.restaurant.findMany()) {
    const uploads = await db.reportUpload.findMany({ where: { restaurantId: r.id }, orderBy: [{ reportType: "asc" }, { periodEnd: "asc" }] });
    console.log(`\n=== ${r.name}: ${uploads.length} report files ===`);
    for (const u of uploads) console.log(`  ${(REPORT_LABELS[u.reportType as keyof typeof REPORT_LABELS] ?? u.reportType).padEnd(36)} ${day(u.periodStart)} – ${day(u.periodEnd)}  ${u.status.padEnd(9)} ${u.fileName}`);

    const used = uploads.filter((u) => u.status !== "FLAGGED");
    const reports = used.map((u) => u.data as unknown as ParsedReport);
    console.log("\n  What the AI's numbers cover:");
    for (const c of coverage(reports)) {
      const label = REPORT_LABELS[c.type as keyof typeof REPORT_LABELS] ?? c.type;
      console.log(`  ${label.padEnd(36)} ${String(c.used).padStart(2)} of ${c.uploaded} ${c.start ? `${c.start} – ${c.end}` : ""}${c.newestOnly ? "   <- weeks don't line up: newest only" : ""}`);
    }

    const ctx = buildContext(r, used.map((u) => ({ report: u.data as unknown as ParsedReport, status: u.status === "CONFIRMED" ? "CONFIRMED" : "READ" })), []);
    console.log("\n  Sources in the AI's first request:");
    for (const name of ["get_week_summary", "get_hourly_sales", "get_day_totals", "get_weekly_trend", "get_sales_mix", "get_daily_sales"]) {
      const t = TOOLS_BY_NAME.get(name)!;
      const out = t.run(ctx, t.parse({})) as { source?: string | string[]; error?: string; weeks?: number };
      console.log(`  ${name.padEnd(18)} ${out.error ?? [out.source].flat().join("; ")}${typeof out.weeks === "number" ? ` (${out.weeks} weeks)` : ""}`);
    }
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
