import Link from "next/link";
import { ButtonLink, Card, Notice, Pill } from "@/components/ui";
import { buildContext } from "@/lib/analyst";
import { buildStoreReport } from "@/lib/analyst/report";
import { db } from "@/lib/db";
import { usableReports } from "@/lib/drafts";
import type { ParsedReport } from "@/lib/reports";
import { requireRestaurant } from "@/lib/restaurant";
import { AppShell } from "../inbox/shell";

type Obj = Record<string, unknown>;
type Finding = { title: string; detail: string; citations: { source: string }[] };

const money = (v: unknown, cents = false) =>
  typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }) : "–";
const pct = (v: unknown) => (typeof v === "number" ? `${v}%` : "–");
const count = (v: unknown) => (typeof v === "number" ? Math.round(v).toLocaleString("en-US") : "–");
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sourceText = (o: Obj | null) => (o ? [o.source].flat().filter(Boolean).join("; ") : "");
const MIX_NAMES: Record<string, string> = { footlong: "Footlong", six_inch: "6-inch", three_inch: "3-inch", salads: "Salads", pizza: "Pizza", other: "Other" };
const CATERING_NAMES: Record<string, string> = { giantSubs: "Giant subs", sandwichPlatters: "Sandwich platters", boxedMeals: "Boxed meals", dessertPlatters: "Dessert platters" };

function Section({ title, source, children }: { title: string; source?: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {source && <p className="text-[13px] text-muted">{source}</p>}
      </div>
      {children}
    </Card>
  );
}

/** Horizontal bars, scaled to the largest value. */
function Bars({ rows }: { rows: { label: string; value: number; text: string; highlight?: boolean }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[64px_minmax(0,1fr)_76px] items-center gap-3 text-sm">
          <span className="text-ink-2">{r.label}</span>
          <span className="h-3 rounded-full bg-sand">
            <span className={`block h-3 rounded-full ${r.highlight ? "bg-sun" : "bg-primary"}`} style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </span>
          <span className="text-right tabular-nums">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function StoreReportPage() {
  const restaurant = await requireRestaurant();
  const [{ rows }, pending, lastRun] = await Promise.all([
    usableReports(restaurant.id),
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.analysisRun.findFirst({ where: { restaurantId: restaurant.id, purpose: "offers", status: "DONE" }, orderBy: { createdAt: "desc" } }),
  ]);
  const ctx = buildContext(
    restaurant,
    rows.map((r) => ({ report: r.data as unknown as ParsedReport, status: r.status === "CONFIRMED" ? "CONFIRMED" : "READ" })),
    [],
  );
  const r = buildStoreReport(ctx);
  const findings = ((lastRun?.findings as unknown as Finding[] | null) ?? []).slice(0, 6);
  const weeksAvg = typeof r.week?.weeks_averaged === "number" ? r.week.weeks_averaged : 1;

  const trendRows = (r.trend?.rows ?? []) as Obj[];
  const change = (r.trend?.change_first_to_last_pct ?? {}) as Record<string, number | null>;
  const hourly = ((r.hourly?.rows ?? []) as { hour: string; hour24: number; sales: number }[]).filter((h) => h.sales > 0);
  const slowest = hourly.filter((h) => h.hour24 >= 10 && h.hour24 <= 19).sort((a, b) => a.sales - b.sales)[0]?.hour24;
  const days = (r.days?.days ?? []) as { day: string; sales: number; customers: number }[];
  const mix = (r.mix?.sandwich_mix ?? []) as { item: string; units: number; share_pct: number | null }[];
  const catering = ((r.mix?.catering_by_type ?? []) as { kind: string; quantity: number; dollars: number }[]).filter((c) => c.quantity > 0 || c.dollars > 0);
  const addOns = (r.mix?.add_on_items ?? []) as { item: string; used_per_week: number; unit_cost: number | null }[];
  const stock = ((r.stock?.categories ?? []) as { category: string; used_dollars: number; diff_dollars: number | null }[]).filter(
    (c) => c.diff_dollars != null && c.diff_dollars !== 0 && !/total|cost of goods/i.test(c.category),
  );
  const bread = (r.bread?.days ?? []) as { day: string; bread: number }[];
  const weekdays = (r.daily?.by_weekday ?? []) as { weekday: string; average_sales: number | null }[];
  const others = (r.reports?.other_reports ?? []) as { number: number; title: string; rows: number; columns: string[] }[];
  const fileCount = rows.length;

  const tiles = [
    { label: "Net sales a week", value: money(r.week?.net_sales), change: change.net_sales },
    { label: "Customers a week", value: count(r.week?.customers), change: change.customers },
    { label: "Average order", value: money(r.week?.average_ticket, true), change: change.average_ticket },
    { label: "Orders with a drink", value: pct(r.week?.drink_attach_pct), change: change.drink_attach_pct },
    { label: "Catering a week", value: money(r.week?.catering_sales), change: change.catering_sales },
    { label: "Discounts, share of sales", value: pct(r.week?.discounts_pct_of_sales), change: change.discounts_pct_of_sales },
  ];

  return (
    <AppShell pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">Store report</h1>
        <p className="max-w-[66ch] text-muted">
          What your reports say, as a typical week{weeksAvg > 1 ? ` (the average of your last ${weeksAvg} weeks)` : ""}. These are the same numbers the AI reads before it suggests deals and catering picks. Read
          from {fileCount} report {fileCount === 1 ? "file" : "files"}.
        </p>
      </div>

      {fileCount === 0 ? (
        <Card className="flex flex-col items-start gap-3 p-8">
          <h2 className="text-xl font-bold">No reports yet</h2>
          <p className="text-ink-2">Add 4 weeks of Day Part Sales and WISR, and your report appears here.</p>
          <ButtonLink href="/setup/reports">Add reports</ButtonLink>
        </Card>
      ) : (
        <>
          {r.highlights.length > 0 && (
            <Section title="What stands out">
              <ul className="grid gap-3 md:grid-cols-2">
                {r.highlights.map((h) => (
                  <li key={h.title} className="flex flex-col gap-1 rounded-2xl bg-ground p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-bold">{h.title}</p>
                      <Pill tone={h.tone === "good" ? "green" : h.tone === "watch" ? "sun" : "sand"}>{h.tone === "good" ? "Good" : h.tone === "watch" ? "Watch" : "Note"}</Pill>
                    </div>
                    <p className="text-[15px] text-ink-2">{h.detail}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {r.week && (
            <Section title="Key numbers" source={sourceText(r.week)}>
              <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {tiles.map((t) => (
                  <li key={t.label} className="rounded-2xl bg-ground p-4">
                    <p className="text-[13px] text-muted">{t.label}</p>
                    <p className="text-2xl font-extrabold tabular-nums">{t.value}</p>
                    {t.change != null && trendRows.length > 1 && (
                      <p className={`text-[13px] ${Math.abs(t.change) < 1 ? "text-muted" : t.change > 0 ? "text-primary-ink" : "text-danger"}`}>
                        {Math.abs(t.change) < 1 ? `Steady over ${trendRows.length} weeks` : `${t.change > 0 ? "▲ Up" : "▼ Down"} ${Math.abs(t.change)}% over ${trendRows.length} weeks`}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {trendRows.length > 1 && (
            <Section title="Week by week" source={sourceText(r.trend)}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm tabular-nums">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="py-1.5 font-semibold">Week ending</th>
                      <th className="py-1.5 text-right font-semibold">Net sales</th>
                      <th className="py-1.5 text-right font-semibold">Customers</th>
                      <th className="py-1.5 text-right font-semibold">Avg order</th>
                      <th className="py-1.5 text-right font-semibold">Drinks</th>
                      <th className="py-1.5 text-right font-semibold">Discounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trendRows.map((w) => (
                      <tr key={String(w.week_end)} className="border-t border-sand">
                        <td className="py-1.5">{shortDate(String(w.week_end))}</td>
                        <td className="py-1.5 text-right">{money(w.net_sales ?? w.daypart_sales)}</td>
                        <td className="py-1.5 text-right">{count(w.customers)}</td>
                        <td className="py-1.5 text-right">{money(w.average_ticket, true)}</td>
                        <td className="py-1.5 text-right">{pct(w.drink_attach_pct)}</td>
                        <td className="py-1.5 text-right">{pct(w.discounts_pct_of_sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-2">
            {hourly.length > 0 && (
              <Section title="Sales by hour, typical week" source={`${sourceText(r.hourly)}. Yellow: slowest daytime hour.`}>
                <Bars rows={hourly.map((h) => ({ label: h.hour, value: h.sales, text: money(h.sales), highlight: h.hour24 === slowest }))} />
              </Section>
            )}
            {days.length > 0 && (
              <Section title="Sales by day, typical week" source={sourceText(r.days)}>
                <Bars rows={days.map((d) => ({ label: d.day, value: d.sales, text: money(d.sales) }))} />
              </Section>
            )}
            {mix.length > 0 && (
              <Section title="What customers buy" source={sourceText(r.mix)}>
                <Bars rows={mix.map((m) => ({ label: MIX_NAMES[m.item] ?? m.item, value: m.units, text: `${count(m.units)} · ${pct(m.share_pct)}` }))} />
                {typeof r.mix?.units_per_customer === "number" && <p className="text-sm text-ink-2">{r.mix.units_per_customer} sandwiches or salads per customer.</p>}
                {catering.length > 0 && (
                  <p className="text-sm text-ink-2">
                    Catering: {catering.map((c) => `${CATERING_NAMES[c.kind] ?? c.kind} ${c.quantity} (${money(c.dollars)})`).join(", ")} a week.
                  </p>
                )}
              </Section>
            )}
            {addOns.length > 0 && (
              <Section title="Sides, cookies and drinks used" source="WISR inventory items, per typical week">
                <ul className="flex flex-col text-sm">
                  {addOns.slice(0, 8).map((a) => (
                    <li key={a.item} className="flex justify-between gap-3 border-t border-sand py-1.5 first:border-0">
                      <span className="break-words">{a.item}</span>
                      <span className="shrink-0 tabular-nums text-ink-2">
                        {count(a.used_per_week)} used{a.unit_cost != null ? ` · ${money(a.unit_cost, true)} each` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {r.discounts && (
              <Section title="What you already give away" source={sourceText(r.discounts)}>
                <ul className="flex flex-col text-sm">
                  {(
                    [
                      ["Free units", r.discounts.free_units],
                      ["Employee discounts", r.discounts.employee_discounts],
                      ["Value meal discounts", r.discounts.value_meal_discounts],
                      ["Other discounts", r.discounts.other_discounts],
                      ["Total", r.discounts.total],
                    ] as [string, { qty: number; dollars: number } | undefined][]
                  ).map(([label, v]) => (
                    <li key={label} className={`flex justify-between gap-3 border-t border-sand py-1.5 first:border-0 ${label === "Total" ? "font-bold" : ""}`}>
                      <span>{label}</span>
                      <span className="tabular-nums">{v ? `${count(v.qty)} · ${money(v.dollars)}` : "–"}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-ink-2">{pct(r.discounts.pct_of_sales)} of sales.</p>
              </Section>
            )}
            {(stock.length > 0 || bread.length > 0) && (
              <Section title="Stock and waste" source={[sourceText(r.stock), sourceText(r.bread)].filter(Boolean).join("; ")}>
                {stock.length > 0 && (
                  <ul className="flex flex-col text-sm">
                    {stock.map((c) => (
                      <li key={c.category} className="flex justify-between gap-3 border-t border-sand py-1.5 first:border-0">
                        <span>{c.category}</span>
                        <span className={`tabular-nums ${(c.diff_dollars ?? 0) < 0 ? "text-danger" : "text-ink-2"}`}>
                          {(c.diff_dollars ?? 0) < 0 ? `${money(Math.abs(c.diff_dollars!))} more used than sold` : `${money(c.diff_dollars)} less used`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {bread.length > 0 && <p className="text-sm text-ink-2">Bread over (+) or short (−): {bread.map((b) => `${b.day} ${b.bread > 0 ? "+" : ""}${b.bread}`).join(", ")}.</p>}
              </Section>
            )}
            {weekdays.length > 0 && (
              <Section title="Daily sales" source={sourceText(r.daily)}>
                <Bars rows={weekdays.map((w) => ({ label: w.weekday, value: w.average_sales ?? 0, text: money(w.average_sales) }))} />
                <p className="text-sm text-ink-2">
                  Best dates: {(r.daily?.best_dates as { date: string; net_sales: number }[]).map((d) => `${shortDate(d.date)} (${money(d.net_sales)})`).join(", ")}. Weakest:{" "}
                  {(r.daily?.worst_dates as { date: string; net_sales: number }[]).map((d) => `${shortDate(d.date)} (${money(d.net_sales)})`).join(", ")}.
                </p>
              </Section>
            )}
            {others.length > 0 && (
              <Section title="Your other reports" source="Read by the AI when their titles matter for offers">
                <ul className="flex flex-col text-sm">
                  {others.map((o) => (
                    <li key={o.number} className="border-t border-sand py-1.5 first:border-0">
                      <span className="font-semibold">{o.title}</span> <span className="text-muted">· {o.rows} rows: {o.columns.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>

          <Section title="What the AI concluded" source={lastRun ? `From the analysis of ${lastRun.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined}>
            {findings.length === 0 ? (
              <p className="text-ink-2">{lastRun ? "Nothing stood out beyond the offer ideas." : "The AI hasn't studied these reports yet. Its findings appear here after today's plan runs."}</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {findings.map((f) => (
                  <li key={f.title} className="flex flex-col gap-1 rounded-2xl bg-ground p-4">
                    <p className="font-bold">{f.title}</p>
                    <p className="text-[15px] text-ink-2">{f.detail}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/inbox">See the offer ideas</ButtonLink>
              {lastRun && (
                <Link href={`/inbox/analysis/${lastRun.id}`} className="inline-flex min-h-11 items-center font-bold">
                  How the AI decided
                </Link>
              )}
            </div>
          </Section>

          {rows.some((x) => x.status !== "CONFIRMED" && x.reportType !== "extraTable") && (
            <Notice title="Some numbers aren't confirmed yet.">
              Check them on the <Link href="/setup/reports">Sales reports</Link> page.
            </Notice>
          )}
        </>
      )}
    </AppShell>
  );
}
