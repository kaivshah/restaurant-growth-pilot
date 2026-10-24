import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Card, Notice, Pill } from "@/components/ui";
import { db } from "@/lib/db";
import { domainOf, isUsefulDomain } from "@/lib/geo";
import { jobState, processDraftJobs, requeueStaleJobs } from "@/lib/drafts";
import { mapsUrl } from "@/lib/leads";
import { LEAD_SKIP_REASONS, categoryLabel } from "@/lib/leads/score";
import { requireRestaurant } from "@/lib/restaurant";
import { scanMyArea } from "../inbox/actions";
import { AiStatus } from "../inbox/ai-status";
import { AutoRefresh } from "../inbox/auto-refresh";
import { AppShell } from "../inbox/shell";
import { ActionButton } from "./action-button";
import { addLeadContact, excludeLead, findContact, includeLead, pitchLead } from "./actions";

const CATEGORIES = ["office", "coworking", "school", "clinic", "gym", "venue"];
const STATUS: Record<string, { label: string; tone: "sand" | "green" | "sun" | "danger" }> = {
  NEW: { label: "Not pitched", tone: "sand" },
  DRAFTED: { label: "Pitch in inbox", tone: "sun" },
  APPROVED: { label: "Pitch approved", tone: "green" },
  EXCLUDED: { label: "Excluded", tone: "danger" },
};
const SOURCE: Record<string, string> = { predicthq: "PredictHQ", ticketmaster: "Ticketmaster", fake: "Sample data" };

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ c?: string; excluded?: string }> }) {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const { c, excluded } = await searchParams;
  const category = CATEGORIES.includes(c ?? "") ? c : undefined;
  const showExcluded = excluded === "1";

  await requeueStaleJobs();
  after(() => processDraftJobs());

  const [leads, events, job, scan, pending, counts] = await Promise.all([
    db.lead.findMany({
      where: { restaurantId: restaurant.id, ...(category ? { category } : {}), ...(showExcluded ? {} : { status: { not: "EXCLUDED" } }) },
      include: { contacts: { orderBy: { createdAt: "asc" } } },
      orderBy: { fitScore: "desc" },
    }),
    db.event.findMany({ where: { restaurantId: restaurant.id, startsAt: { gte: new Date() } }, include: { venueLead: true }, orderBy: { startsAt: "asc" } }),
    db.draftJob.findFirst({ where: { restaurantId: restaurant.id, kind: "LEADS" }, orderBy: { createdAt: "desc" } }),
    db.leadScan.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { createdAt: "desc" } }),
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.lead.groupBy({ by: ["category"], where: { restaurantId: restaurant.id, status: { not: "EXCLUDED" } }, _count: true }),
  ]);
  const working = jobState(job) === "working";
  const countOf = (cat: string) => counts.find((x) => x.category === cat)?._count ?? 0;
  const href = (next: { c?: string; excluded?: boolean }) => {
    const q = new URLSearchParams();
    if (next.c) q.set("c", next.c);
    if (next.excluded) q.set("excluded", "1");
    return `/leads${q.size ? `?${q}` : ""}`;
  };

  return (
    <AppShell current="leads" pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      {working && <AutoRefresh />}
      <AiStatus job={job} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Leads & events</h1>
          <p className="max-w-[70ch] text-lg text-ink-2">
            Every business and upcoming event we found within {restaurant.radiusMiles} mi of your store. The best ones get a pitch in your{" "}
            <Link href="/inbox?tab=catering">Approval Inbox</Link>.
          </p>
        </div>
        <form action={scanMyArea}>
          <button type="submit" disabled={working} className="min-h-11 rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover disabled:opacity-60">
            {working ? "Scanning…" : "Scan my area"}
          </button>
        </form>
      </div>

      {scan?.status === "FAILED" && !working && (
        <Notice tone="danger" title="The last scan didn't finish.">
          {scan.message}
        </Notice>
      )}
      {scan?.status === "DONE" && (
        <p className="text-sm text-muted">
          Last scan {scan.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })} · places from{" "}
          {scan.placesProvider === "fake" ? "sample data" : "Google"} · contacts from {scan.contactsProvider === "off" ? "nowhere (lookup is off)" : scan.contactsProvider === "fake" ? "sample data" : "Hunter.io"}
          {scan.message ? ` · ${scan.message}` : ""}
        </p>
      )}

      <section aria-labelledby="events-h" className="flex flex-col gap-3">
        <h2 id="events-h" className="text-xl font-bold">
          Upcoming events <span className="font-semibold text-muted">({events.length})</span>
        </h2>
        {events.length === 0 ? (
          <Card className="p-6 text-ink-2">
            No events found for the next 60 days. Event search needs a PredictHQ or Ticketmaster key (see the README), or EVENTS_PROVIDER=fake for sample events.
          </Card>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3">
            {events.map((e) => (
              <li key={e.id} className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-5 py-4">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Pill tone="sun">{e.category[0].toUpperCase() + e.category.slice(1)}</Pill>
                  <span className="text-[13px] font-bold text-muted">Fit {e.fitScore}</span>
                </span>
                <p className="font-bold">{e.title}</p>
                <p className="text-sm text-ink-2">
                  {fmtDay(e.startsAt)}
                  {e.attendance ? ` · ~${e.attendance.toLocaleString("en-US")} expected` : ""}
                  {e.distanceMiles != null ? ` · ${e.distanceMiles} mi` : ""}
                </p>
                <p className="text-sm text-ink-2">
                  {e.venueName ?? "No venue listed"}
                  {e.venueLead ? " · we found the venue, so it can be pitched" : e.venueName ? " · venue not found nearby" : ""}
                </p>
                <p className="text-[13px] text-muted">
                  Source: {SOURCE[e.source] ?? e.source}
                  {e.url && (
                    <>
                      {" · "}
                      <a href={e.url} target="_blank" rel="noreferrer" className="font-bold">
                        Event page
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="leads-h" className="flex flex-col gap-3">
        <h2 id="leads-h" className="text-xl font-bold">
          Nearby businesses <span className="font-semibold text-muted">({leads.length})</span>
        </h2>
        <nav aria-label="Filter by type" className="flex flex-wrap gap-2">
          <Link
            href={href({ excluded: showExcluded })}
            aria-current={!category ? "page" : undefined}
            className={`min-h-10 rounded-full px-3.5 py-2 text-sm font-semibold no-underline ${!category ? "bg-primary text-white" : "border border-field bg-surface text-ink"}`}
          >
            All
          </Link>
          {CATEGORIES.map((cat) => (
            <Link
              key={cat}
              href={href({ c: cat, excluded: showExcluded })}
              aria-current={category === cat ? "page" : undefined}
              className={`min-h-10 rounded-full px-3.5 py-2 text-sm font-semibold no-underline ${category === cat ? "bg-primary text-white" : "border border-field bg-surface text-ink"}`}
            >
              {categoryLabel(cat)} ({countOf(cat)})
            </Link>
          ))}
          <Link href={href({ c: category, excluded: !showExcluded })} className="min-h-10 px-2 py-2 text-sm font-bold">
            {showExcluded ? "Hide excluded" : "Show excluded"}
          </Link>
        </nav>

        {leads.length === 0 ? (
          <Card className="p-6 text-ink-2">{working ? "Scanning…" : "No businesses here yet. Click “Scan my area” to search."}</Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {leads.map((l) => (
              <li key={l.id} className={`grid gap-4 rounded-card border border-line bg-surface px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)] ${l.status === "EXCLUDED" ? "opacity-75" : ""}`}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill>{categoryLabel(l.category)}</Pill>
                    <Pill tone={STATUS[l.status].tone}>
                      {STATUS[l.status].label}
                      {l.excludeReason ? ` · ${l.excludeReason}` : ""}
                    </Pill>
                  </span>
                  <p className="text-[17px] font-bold">
                    {l.name} <span className="text-sm font-semibold text-muted">· fit {l.fitScore} · {l.distanceMiles} mi</span>
                  </p>
                  <p className="text-sm break-words text-ink-2">
                    {l.address} ·{" "}
                    <a href={mapsUrl(l.placeId, l.name)} target="_blank" rel="noreferrer" className="font-bold">
                      Open in Google Maps
                    </a>
                    {l.website && (
                      <>
                        {" · "}
                        <a href={l.website} target="_blank" rel="noreferrer" className="font-bold">
                          Website
                        </a>
                      </>
                    )}
                  </p>
                  <p className="text-[13px] text-muted">{l.scoreReasons.join(" · ")}</p>
                  {l.contacts.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 text-sm">
                      {l.contacts.map((p) => (
                        <li key={p.id} className="break-words">
                          <strong>{p.name ?? p.email}</strong>
                          {p.role ? `, ${p.role}` : ""} · {p.email}
                          <span className="text-muted">
                            {p.source === "owner" ? " · added by you" : ""}
                            {p.verification ? ` · ${p.verification.replace("_", " ")}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">{l.contactsCheckedAt ? "No contacts found." : !isUsefulDomain(domainOf(l.website)) ? "No website to look up contacts. Add one yourself if you know who orders food." : "Contacts not looked up yet."}</p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {l.status === "NEW" && (
                    <ActionButton
                      action={pitchLead}
                      id={l.id}
                      label="Pitch this business"
                      busyLabel="Writing the pitch…"
                      className="min-h-11 w-full rounded-field bg-primary px-4 font-bold text-white hover:bg-primary-hover disabled:opacity-60"
                    />
                  )}
                  {l.status !== "EXCLUDED" && l.contacts.length === 0 && isUsefulDomain(domainOf(l.website)) && !l.contactsCheckedAt && (
                    <ActionButton action={findContact} id={l.id} label="Find contact (1 Hunter lookup)" busyLabel="Searching…" />
                  )}
                  {l.status === "EXCLUDED" ? (
                    <form action={includeLead}>
                      <input type="hidden" name="id" value={l.id} />
                      <button type="submit" className="min-h-11 w-full rounded-field border border-field px-4 font-bold hover:border-primary">
                        Include again
                      </button>
                    </form>
                  ) : (
                    <form action={excludeLead} className="flex gap-2">
                      <input type="hidden" name="id" value={l.id} />
                      <label htmlFor={`r-${l.id}`} className="sr-only">
                        Reason
                      </label>
                      <select id={`r-${l.id}`} name="reason" className="h-11 min-w-0 flex-1 rounded-field border border-field bg-surface px-2 text-sm">
                        {LEAD_SKIP_REASONS.filter((r) => r !== "Contact looks wrong").map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <button type="submit" className="min-h-11 rounded-field border border-[#e8c9c9] px-3 text-sm font-bold text-danger">
                        Exclude
                      </button>
                    </form>
                  )}
                  <details className="rounded-field border border-line px-3 py-2">
                    <summary className="cursor-pointer text-sm font-bold">Add a contact</summary>
                    <form action={addLeadContact} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="id" value={l.id} />
                      <input name="name" placeholder="Name" maxLength={80} aria-label="Name" className="h-10 rounded-field border border-field px-3 text-sm" />
                      <input name="role" placeholder="Role, e.g. Office manager" maxLength={80} aria-label="Role" className="h-10 rounded-field border border-field px-3 text-sm" />
                      <input name="email" type="email" required placeholder="Email" aria-label="Email" className="h-10 rounded-field border border-field px-3 text-sm" />
                      <button type="submit" className="min-h-10 rounded-field bg-primary text-sm font-bold text-white hover:bg-primary-hover">
                        Save contact
                      </button>
                    </form>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
