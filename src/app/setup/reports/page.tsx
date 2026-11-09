import { Card, CheckIcon, Notice, Pill } from "@/components/ui";
import { db } from "@/lib/db";
import { coverage } from "@/lib/insights";
import { GROUP_TYPES, MAX_EXTRA_FILES, MAX_WEEKS, MIN_WEEKS, REPORT_LABELS, type UploadGroup, type WeekRow, completeWeeks, summarise, weeksOf } from "@/lib/reports";
import type { ParsedReport } from "@/lib/reports";
import { requireRestaurant } from "@/lib/restaurant";
import { confirmNumbers, removeReport, removeWeek } from "../actions";
import { ConfirmList } from "./confirm-list";
import { MoreWeeks, WeekUpload } from "./week-upload";

function fmtDate(d: Date | null) {
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
}

function weekLabel(start: Date | null, end: Date | null) {
  if (!end) return "Week unknown";
  return start ? `${fmtDate(start)} – ${fmtDate(end)}` : `Week ending ${fmtDate(end)}`;
}

export default async function ReportsStep({ searchParams }: { searchParams: Promise<{ flagged?: string; saved?: string; need?: string }> }) {
  const restaurant = await requireRestaurant();
  const { flagged, saved, need } = await searchParams;
  const uploads = await db.reportUpload.findMany({
    where: { restaurantId: restaurant.id },
    orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
  });

  // Each section's weeks, oldest first. Four complete weeks of each are needed; up to eight are kept.
  const dayWeeks = weeksOf("dayPart", uploads);
  const wisrWeeks = weeksOf("wisr", uploads);
  const optional = uploads.filter((u) => (GROUP_TYPES.other as string[]).includes(u.reportType));
  const dayDone = completeWeeks(dayWeeks).length;
  const wisrDone = completeWeeks(wisrWeeks).length;
  const ready = dayDone >= MIN_WEEKS && wisrDone >= MIN_WEEKS;

  // Numbers to confirm: the most recent week that has a WISR sales, units or discount report.
  const wisrWeek = uploads.find((u) => ["wisrSales", "wisrUnits", "wisrAdjCogs"].includes(u.reportType))?.periodEnd ?? null;
  const weekReports = wisrWeek
    ? uploads.filter((u) => u.periodEnd?.getTime() === wisrWeek.getTime()).map((u) => u.data as unknown as ParsedReport)
    : [];
  const summary = summarise(weekReports);
  // What the AI's numbers actually cover, report by report.
  const covered = coverage(uploads.filter((u) => u.status !== "FLAGGED").map((u) => u.data as unknown as ParsedReport));
  const rangeOf = (start: string | null, end: string | null) => (start && end ? weekLabel(new Date(start), new Date(end)) : "");
  const weekUploads = wisrWeek ? uploads.filter((u) => u.periodEnd?.getTime() === wisrWeek.getTime()) : [];
  const weekConfirmed = weekUploads.length > 0 && weekUploads.every((u) => u.status === "CONFIRMED");

  /** One section: its uploaded weeks, empty slots up to four, then "add another week" up to eight. */
  const section = (group: UploadGroup, title: string, note: string, rows: WeekRow[], required: boolean) => {
    const empty = required ? Math.max(0, MIN_WEEKS - rows.length) : rows.length ? 0 : 1;
    const done = completeWeeks(rows).length;
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-5">
          <div>
            <h2 className="text-lg font-bold">{title}</h2>
            <p className="text-[13px] text-muted">{note}</p>
          </div>
          {required ? (
            <Pill tone={done >= MIN_WEEKS ? "green" : "sand"}>
              {done >= MIN_WEEKS ? `${done} weeks added` : `${done} of ${MIN_WEEKS} weeks added`}
            </Pill>
          ) : (
            <Pill>Optional</Pill>
          )}
        </div>
        <ul>
          {rows.map((r, i) => (
            <li key={r.end} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-sand px-6 py-3.5">
              {r.missing.length || r.flagged ? <span className="size-6 rounded-full bg-sun" aria-hidden="true" /> : <CheckIcon />}
              <div className="min-w-0">
                <p className="font-semibold">
                  Week {i + 1} <span className="font-normal text-ink-2">· {weekLabel(r.start ? new Date(r.start) : null, new Date(r.end))}</span>
                </p>
                <p className="text-[13px] break-words text-muted">
                  {r.flagged
                    ? "You marked a number from this week as wrong: upload this week again."
                    : r.missing.length
                      ? `Missing ${r.missing.map((t) => REPORT_LABELS[t]).join(", ")}: upload this week's WISR zip again.`
                      : group === "wisr"
                        ? `${r.types.length} of 6 reports · ${r.fileNames.join(", ")}`
                        : r.fileNames.join(", ")}
                </p>
              </div>
              <form action={removeWeek}>
                <input type="hidden" name="group" value={group} />
                <input type="hidden" name="end" value={r.end} />
                <button type="submit" className="min-h-11 rounded-field px-3 text-sm font-semibold text-muted hover:text-danger" aria-label={`Remove ${title} week ${i + 1}`}>
                  Remove
                </button>
              </form>
            </li>
          ))}
          {Array.from({ length: empty }, (_, i) => (
            <WeekUpload key={`empty-${rows.length + i}`} group={group} label={required ? `Week ${rows.length + i + 1}` : "Upload"} />
          ))}
          {required && rows.length >= MIN_WEEKS && <MoreWeeks key={`more-${rows.length}`} group={group} next={rows.length + 1} max={MAX_WEEKS} />}
          {required && rows.length > MAX_WEEKS && (
            <li className="border-t border-sand px-6 py-3 text-[13px] text-muted">The AI reads the latest {MAX_WEEKS} weeks; remove older ones you don&apos;t need.</li>
          )}
        </ul>
      </Card>
    );
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">{restaurant.setupCompletedAt ? "Sales reports" : "Add your weekly reports"}</h1>
        <p className="max-w-[62ch] text-muted">
          Add {MIN_WEEKS} recent weeks of each export from your back office, one week per button, as the files download. We read the numbers, show you what we found, and use them only after you confirm.
        </p>
      </div>

      {saved && <Notice tone="green">Thanks. New offer ideas from these numbers will appear in the Approval Inbox.</Notice>}
      {restaurant.setupCompletedAt && ready && (
        <p className="text-[13px] text-muted">When you add or remove a report here, the analysis and offers are redone by themselves about a minute later.</p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          {need && !ready && (
            <Notice tone="danger" title={`Add ${MIN_WEEKS} weeks of each first.`}>
              The deals and picks are worked out from weekly averages, so they need at least {MIN_WEEKS} weeks of Day Part Sales and {MIN_WEEKS} weeks of WISR.
            </Notice>
          )}
          {section("dayPart", "1. Day Part Sales", "Day Part / Hourly Sales & Units: one CSV per week. Sales by hour and day, for your slow and busy times.", dayWeeks, true)}
          {section("wisr", "2. WISR", "The weekly WISR export as it downloads (a zip with six reports): sales mix, customers, discounts, costs.", wisrWeeks, true)}
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-5">
              <div>
                <h2 className="text-lg font-bold">3. Other reports</h2>
                <p className="text-[13px] text-muted">
                  Cash In Week (daily sales by date), or any other back-office export as CSV or Excel, such as item or promotion sales. The AI reads them too. Files with names, contact or pay details are refused.
                </p>
              </div>
              <Pill>{optional.length ? `${optional.length} of ${MAX_EXTRA_FILES} added` : "Optional"}</Pill>
            </div>
            <ul>
              {optional.map((u) => {
                const r = u.data as unknown as ParsedReport;
                const what = r.type === "extraTable" ? `${r.title} · ${r.rowCount} rows, ${r.columns.length} columns` : `${REPORT_LABELS[r.type]}${r.period ? ` · ${weekLabel(new Date(r.period.start), new Date(r.period.end))}` : ""}`;
                return (
                  <li key={u.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-sand px-6 py-3.5">
                    <CheckIcon />
                    <div className="min-w-0">
                      <p className="font-semibold break-words">{what}</p>
                      <p className="text-[13px] break-words text-muted">{u.fileName}</p>
                    </div>
                    <form action={removeReport}>
                      <input type="hidden" name="id" value={u.id} />
                      <button type="submit" className="min-h-11 rounded-field px-3 text-sm font-semibold text-muted hover:text-danger" aria-label={`Remove ${u.fileName}`}>
                        Remove
                      </button>
                    </form>
                  </li>
                );
              })}
              {optional.length < MAX_EXTRA_FILES ? (
                <WeekUpload key={`other-${optional.length}`} group="other" label={optional.length ? "Add another file" : "Upload a file"} optional />
              ) : (
                <li className="border-t border-sand px-6 py-3 text-[13px] text-muted">That&apos;s the most: {MAX_EXTRA_FILES} optional files. Remove one to add a different file.</li>
              )}
            </ul>
          </Card>
          <p className="text-[13px] text-muted">
            Upload weeks in any order; they&apos;re sorted by date. The AI uses weekly averages of all the weeks you add ({MIN_WEEKS} needed, up to {MAX_WEEKS}), so one unusual week doesn&apos;t skew the
            deals. More weeks means more for the AI to read, so {MAX_WEEKS} is the most.
          </p>
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
                  <p className="text-sm text-muted">
                    Your newest WISR week ({summary.period ? weekLabel(new Date(summary.period.start), new Date(summary.period.end)) : ""}), to check the files were read right. The AI uses all
                    your weeks, averaged: see &ldquo;What the AI reads&rdquo; below.
                  </p>
                </div>
                <input type="hidden" name="periodEnd" value={wisrWeek?.toISOString().slice(0, 10) ?? ""} />
                <ConfirmList numbers={summary.numbers.map(({ key, label, display }) => ({ key, label, display }))} />
                {flagged && (
                  <Notice tone="danger" title="Thanks for checking.">
                    Please export the reports marked &ldquo;Check again&rdquo; once more and upload them. The new copy replaces the old one.
                  </Notice>
                )}
                {weekConfirmed && !flagged && <Notice tone="green">You confirmed these numbers.</Notice>}
                {!ready && (
                  <p className="text-sm font-semibold text-ink-2">
                    Add {MIN_WEEKS} weeks of each to continue: Day Part Sales {Math.min(dayDone, MIN_WEEKS)} of {MIN_WEEKS}, WISR {Math.min(wisrDone, MIN_WEEKS)} of {MIN_WEEKS}.
                  </p>
                )}
                <button
                  type="submit"
                  disabled={!ready}
                  className="inline-flex min-h-[52px] items-center justify-center rounded-field bg-primary px-6 font-bold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {restaurant.setupCompletedAt ? "Confirm these numbers" : "Save and continue"}
                </button>
              </form>
            )}
          </Card>
          {covered.length > 0 && (
            <Card className="flex flex-col gap-3 p-6">
              <div>
                <h2 className="text-lg font-bold">What the AI reads</h2>
                <p className="text-sm text-muted">For each report: the weeks uploaded, and the weeks its numbers are averaged over (the latest {MAX_WEEKS} at most).</p>
              </div>
              <ul className="flex flex-col text-sm">
                {covered.map((c) => (
                  <li key={c.type} className="flex flex-col border-t border-sand py-2 first:border-0">
                    <span className="flex justify-between gap-3">
                      <span className="font-semibold">{REPORT_LABELS[c.type as keyof typeof REPORT_LABELS] ?? c.type}</span>
                      <span className={`shrink-0 tabular-nums ${c.newestOnly ? "font-bold text-danger" : "text-ink-2"}`}>
                        {c.type === "extraTable" ? `${c.used} ${c.used === 1 ? "file" : "files"}` : c.type === "cashInWeek" ? `${c.used} ${c.used === 1 ? "file" : "files"}, every date` : `${c.used} of ${c.uploaded} weeks`}
                      </span>
                    </span>
                    {rangeOf(c.start, c.end) && <span className="text-[13px] text-muted">{rangeOf(c.start, c.end)}</span>}
                    {c.newestOnly && <span className="text-[13px] text-danger">Its weeks don&apos;t line up (different layout), so only the newest is used. Re-export them from the same report screen.</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="rounded-card bg-sand px-6 py-5 text-[15px] text-ink-2">
            <p className="mb-1 font-bold text-ink">Please don&apos;t upload</p>
            Bank statements, or labor files with employee names. We never need them, and they hold private details.
          </div>
        </aside>
      </div>
    </>
  );
}
