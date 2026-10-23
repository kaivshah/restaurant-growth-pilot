import { Card, CheckIcon, Notice, Pill } from "@/components/ui";
import { db } from "@/lib/db";
import { REPORT_LABELS, REQUIRED_REPORTS, summarise } from "@/lib/reports";
import type { ParsedReport, ReportType } from "@/lib/reports";
import { requireRestaurant } from "@/lib/restaurant";
import { confirmNumbers, removeReport } from "../actions";
import { ConfirmList } from "./confirm-list";
import { UploadBox } from "./upload-box";

const OPTIONAL_REPORTS: ReportType[] = ["wisrInventoryItems", "wisrInventoryCategories", "wisrBreadOverShort", "cashInWeek"];

const WHY: Record<ReportType, string> = {
  dayPart: "Sales by hour and day: finds your slow times",
  wisrSales: "Weekly sales mix, including catering",
  wisrUnits: "Customers, average ticket and drink orders",
  wisrAdjCogs: "How much you already give away in discounts",
  wisrInventoryItems: "Ingredient costs, so offers stay profitable",
  wisrInventoryCategories: "Overuse and waste by category",
  wisrBreadOverShort: "Extra bread by day",
  cashInWeek: "Daily net sales",
};

function fmtDate(d: Date | null) {
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
}

function weekLabel(start: Date | null, end: Date | null) {
  if (!end) return "Week unknown";
  return start ? `${fmtDate(start)} – ${fmtDate(end)}` : `Week ending ${fmtDate(end)}`;
}

export default async function ReportsStep({ searchParams }: { searchParams: Promise<{ flagged?: string }> }) {
  const restaurant = await requireRestaurant();
  const { flagged } = await searchParams;
  const uploads = await db.reportUpload.findMany({
    where: { restaurantId: restaurant.id },
    orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
  });

  // Latest upload of each type
  const latest = new Map<string, (typeof uploads)[number]>();
  for (const u of uploads) if (!latest.has(u.reportType)) latest.set(u.reportType, u);
  const requiredDone = REQUIRED_REPORTS.filter((t) => latest.has(t)).length;

  // Do the required reports cover different weeks?
  const requiredEnds = new Set(
    REQUIRED_REPORTS.map((t) => latest.get(t)?.periodEnd?.toISOString().slice(0, 10)).filter(Boolean),
  );
  const mixedWeeks = requiredEnds.size > 1;

  // Numbers to confirm: the most recent week that has a WISR sales, units or discount report.
  const wisrWeek = uploads.find((u) => ["wisrSales", "wisrUnits", "wisrAdjCogs"].includes(u.reportType))?.periodEnd ?? null;
  const weekReports = wisrWeek
    ? uploads.filter((u) => u.periodEnd?.getTime() === wisrWeek.getTime()).map((u) => u.data as unknown as ParsedReport)
    : [];
  const summary = summarise(weekReports);
  const weekUploads = wisrWeek ? uploads.filter((u) => u.periodEnd?.getTime() === wisrWeek.getTime()) : [];
  const weekConfirmed = weekUploads.length > 0 && weekUploads.every((u) => u.status === "CONFIRMED");

  const row = (type: ReportType) => {
    const u = latest.get(type);
    return (
      <li key={type} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-sand px-6 py-3.5">
        {u ? (
          <CheckIcon />
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10.5" fill="none" stroke="#B9B2A3" strokeWidth="2" strokeDasharray="3 3" />
          </svg>
        )}
        <div className="min-w-0">
          <p className="font-semibold">{REPORT_LABELS[type]}</p>
          <p className="text-[13px] break-words text-muted">{u ? u.fileName : WHY[type]}</p>
        </div>
        {u ? (
          <div className="flex items-center gap-2">
            {u.status === "FLAGGED" ? <Pill tone="danger">Check again</Pill> : <Pill tone={mixedWeeks && REQUIRED_REPORTS.includes(type) ? "sun" : "sand"}>{weekLabel(u.periodStart, u.periodEnd)}</Pill>}
            <form action={removeReport}>
              <input type="hidden" name="id" value={u.id} />
              <button type="submit" className="min-h-11 rounded-field px-3 text-sm font-semibold text-muted hover:text-danger" aria-label={`Remove ${REPORT_LABELS[type]}`}>
                Remove
              </button>
            </form>
          </div>
        ) : (
          <span className="text-sm text-muted">Not added</span>
        )}
      </li>
    );
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">Add your weekly reports</h1>
        <p className="max-w-[62ch] text-muted">
          Export them from your back office as CSV or Excel. We read the numbers, show you what we found, and use them only after you confirm.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <UploadBox />

          {mixedWeeks && (
            <Notice title="These files cover different weeks.">
              Add the same weeks for every required report so we can compare them. Uploading a report for a week you already added replaces it.
            </Notice>
          )}

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-5">
              <h2 className="text-lg font-bold">Your files</h2>
              <Pill tone={requiredDone === REQUIRED_REPORTS.length ? "green" : "sand"}>
                {requiredDone} of {REQUIRED_REPORTS.length} required added
              </Pill>
            </div>
            <p className="bg-ground px-6 py-2 text-[13px] font-bold text-muted">Required to start</p>
            <ul>{REQUIRED_REPORTS.map(row)}</ul>
            <p className="border-t border-sand bg-ground px-6 py-2 text-[13px] font-bold text-muted">For better recommendations</p>
            <ul>{OPTIONAL_REPORTS.map(row)}</ul>
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card className="flex flex-col gap-4 p-6">
            {summary.numbers.length === 0 ? (
              <>
                <h2 className="text-lg font-bold">Do these numbers look right?</h2>
                <p className="text-muted">Add your WISR sales, units and discount reports, and we&apos;ll show what we read here for you to check.</p>
              </>
            ) : (
              <form action={confirmNumbers} className="flex flex-col gap-4">
                <div>
                  <h2 className="text-lg font-bold">Do these numbers look right?</h2>
                  <p className="text-sm text-muted">{summary.period ? weekLabel(new Date(summary.period.start), new Date(summary.period.end)) : ""} · read from your WISR files</p>
                </div>
                <input type="hidden" name="periodEnd" value={wisrWeek?.toISOString().slice(0, 10) ?? ""} />
                <ConfirmList numbers={summary.numbers.map(({ key, label, display }) => ({ key, label, display }))} />
                {flagged && (
                  <Notice tone="danger" title="Thanks for checking.">
                    Please export the reports marked &ldquo;Check again&rdquo; once more and upload them. The new copy replaces the old one.
                  </Notice>
                )}
                {weekConfirmed && !flagged && <Notice tone="green">You confirmed these numbers.</Notice>}
                <button type="submit" className="inline-flex min-h-[52px] items-center justify-center rounded-field bg-primary px-6 font-bold text-white hover:bg-primary-hover">
                  Save and continue
                </button>
              </form>
            )}
          </Card>
          <div className="rounded-card bg-sand px-6 py-5 text-[15px] text-ink-2">
            <p className="mb-1 font-bold text-ink">Please don&apos;t upload</p>
            Bank statements, or labor files with employee names. We never need them, and they hold private details.
          </div>
        </aside>
      </div>
    </>
  );
}
