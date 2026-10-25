import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { Prisma } from "@prisma/client";
import { Card, Notice, Pill } from "@/components/ui";
import { analystFromEnv } from "@/lib/analyst";
import { db } from "@/lib/db";
import { jobState, kickJobs, pitchesInProgress, requeueStaleJobs } from "@/lib/drafts";
import { latestSuggestions, mapsUrl } from "@/lib/leads";
import { LEAD_SKIP_REASONS, categoryLabel } from "@/lib/leads/score";
import { requireRestaurant } from "@/lib/restaurant";
import { scanMyArea } from "../inbox/actions";
import { AiStatus } from "../inbox/ai-status";
import { AutoRefresh } from "../inbox/auto-refresh";
import { AppShell } from "../inbox/shell";
import { addLeadContact, excludeLead, includeLead, queuePitches, suggestAction } from "./actions";

const LEAD_TYPES = ["office", "coworking", "school", "clinic", "gym", "venue"];
const EVENT_TYPES = ["conference", "expo", "corporate", "community", "sports", "school", "concert", "other"];
const STATUS: Record<string, { label: string; tone: "sand" | "green" | "sun" | "danger" }> = {
  NEW: { label: "Not pitched", tone: "sand" },
  DRAFTED: { label: "Pitch in inbox", tone: "sun" },
  APPROVED: { label: "Pitch approved", tone: "green" },
  EXCLUDED: { label: "Excluded", tone: "danger" },
};
const SOURCE: Record<string, string> = { predicthq: "PredictHQ", ticketmaster: "Ticketmaster", web: "Web search", fake: "Sample data" };

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = (v: string | undefined, allowed: string[], fallback: string) => (v && allowed.includes(v) ? v : fallback);

type Params = { view?: string; type?: string; within?: string; days?: string; from?: string; to?: string; sort?: string; status?: string; q?: string };

const DAY_MS = 86_400_000;
/** "2026-11-14" → that day in San Diego (noon UTC is safely inside it), or null. */
const dateParam = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const primaryBtn = "min-h-11 w-full rounded-field bg-primary px-4 font-bold text-white hover:bg-primary-hover disabled:opacity-60";
const field = "h-11 rounded-field border border-field bg-surface px-3 text-sm";

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const params = await searchParams;

  await requeueStaleJobs();
  after(() => kickJobs());

  const now = new Date();
  const [eventCount, leadCount] = await Promise.all([
    db.event.count({ where: { restaurantId: restaurant.id, startsAt: { gte: now } } }),
    db.lead.count({ where: { restaurantId: restaurant.id, status: { not: "EXCLUDED" } } }),
  ]);
  const view = pick(params.view, ["events", "businesses"], eventCount > 0 ? "events" : "businesses");
  const within = pick(params.within, ["1", "2", "3", "5", "10", "any"], "any");
  const days = pick(params.days, ["7", "14", "28", "60", "custom"], "60");
  const from = dateParam(params.from);
  const to = dateParam(params.to);
  // Custom dates: whole days from "from" through "to"; otherwise from now for the chosen weeks.
  // Filling in either date means "use these dates", whatever the dropdown says.
  const custom = days === "custom" || Boolean(from || to);
  const window =
    custom
      ? { gte: from ? new Date(`${from}T00:00:00-08:00`) : now, lte: to ? new Date(`${to}T23:59:59-08:00`) : new Date(now.getTime() + 60 * DAY_MS) }
      : { gte: now, lte: new Date(now.getTime() + Number(days) * DAY_MS) };
  const q = (params.q ?? "").trim().slice(0, 80);
  const eventType = pick(params.type, EVENT_TYPES, "");
  const leadType = pick(params.type, LEAD_TYPES, "");
  const status = pick(params.status, ["open", "pitched", "excluded", "all"], "open");
  const sort = pick(params.sort, ["date", "fit", "distance", "attendance", "ai", "name"], view === "events" ? "date" : "fit");
  const near = within === "any" ? {} : { distanceMiles: { lte: Number(within) } };

  const eventWhere: Prisma.EventWhereInput = {
    restaurantId: restaurant.id,
    startsAt: { gte: window.gte < now ? now : window.gte, lte: window.lte },
    ...(eventType ? { category: eventType } : {}),
    ...near,
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { venueName: { contains: q, mode: "insensitive" } }, { organizer: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const leadWhere: Prisma.LeadWhereInput = {
    restaurantId: restaurant.id,
    ...(leadType ? { category: leadType } : {}),
    ...near,
    ...(status === "open" ? { status: { in: ["NEW", "DRAFTED"] } } : status === "pitched" ? { status: { in: ["DRAFTED", "APPROVED"] } } : status === "excluded" ? { status: "EXCLUDED" } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { address: { contains: q, mode: "insensitive" } }] } : {}),
  };

  const [events, leads, scanJob, suggestJob, pitchJob, writing, scan, pending, pitches, suggestions] = await Promise.all([
    view === "events" ? db.event.findMany({ where: eventWhere, include: { venueLead: true }, take: 150 }) : Promise.resolve([]),
    view === "businesses" ? db.lead.findMany({ where: leadWhere, include: { contacts: { orderBy: { createdAt: "asc" } } }, take: 150 }) : Promise.resolve([]),
    db.draftJob.findFirst({ where: { restaurantId: restaurant.id, kind: "LEADS" }, orderBy: { createdAt: "desc" } }),
    db.draftJob.findFirst({ where: { restaurantId: restaurant.id, kind: "SUGGEST" }, orderBy: { createdAt: "desc" } }),
    db.draftJob.findFirst({ where: { restaurantId: restaurant.id, kind: "PITCH" }, orderBy: { createdAt: "desc" } }),
    pitchesInProgress(restaurant.id),
    db.leadScan.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { createdAt: "desc" } }),
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.draft.findMany({ where: { restaurantId: restaurant.id, kind: "CATERING_PITCH", status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, leadId: true, eventId: true } }),
    latestSuggestions(restaurant.id),
  ]);
  const scanning = jobState(scanJob) === "working";
  const suggesting = jobState(suggestJob) === "working";
  const pitching = jobState(pitchJob) === "working";
  const recentPitchJob = pitchJob && pitchJob.finishedAt && now.getTime() - pitchJob.finishedAt.getTime() < 10 * 60_000 ? pitchJob : null;
  const aiOn = Boolean(analystFromEnv("leads"));
  const pitchFor = (leadId: string | null, eventId: string | null) => pitches.find((p) => (eventId ? p.eventId === eventId : p.leadId === leadId && !p.eventId));
  const aiFor = (leadId: string | null, eventId: string | null) => {
    const s = leadId ? suggestions.byLead.get(leadId) : undefined;
    return s && (s.eventId ?? null) === eventId ? s : undefined;
  };

  const by = <T,>(f: (x: T) => number | string | null) => (a: T, b: T) => {
    const x = f(a);
    const y = f(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  };
  if (sort === "date") events.sort(by((e) => e.startsAt.getTime()));
  if (sort === "fit") events.sort(by((e) => -e.fitScore));
  if (sort === "distance") events.sort(by((e) => e.distanceMiles));
  if (sort === "attendance") events.sort(by((e) => (e.attendance ? -e.attendance : null)));
  if (sort === "ai") events.sort(by((e) => (aiFor(e.venueLeadId, e.id) ? 0 : 1)));
  if (sort === "fit") leads.sort(by((l) => -l.fitScore));
  if (sort === "distance") leads.sort(by((l) => l.distanceMiles));
  if (sort === "name") leads.sort(by((l) => l.name.toLowerCase()));
  if (sort === "ai") leads.sort(by((l) => (aiFor(l.id, null) ? 0 : 1) * 1000 - l.fitScore));

  const tabHref = (v: string) => `/leads?view=${v}`;
  const waitingJob = [pitchJob, suggestJob].find((j) => jobState(j) === "waiting") ?? scanJob;

  return (
    <AppShell current="leads" pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      {(scanning || suggesting || pitching) && <AutoRefresh />}
      {/* Row checkboxes and buttons belong to this form through their form="bulk" attribute. */}
      <form id="bulk" action={queuePitches} />
      <AiStatus job={waitingJob} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Leads & events</h1>
          <p className="max-w-[72ch] text-lg text-ink-2">
            Businesses and upcoming events within {restaurant.radiusMiles} mi of your store. Pick the ones you like and click <strong>Generate pitch</strong>; the
            email waits in your <Link href="/inbox?tab=catering">Approval Inbox</Link>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {aiOn && (
            <form action={suggestAction}>
              <button type="submit" disabled={suggesting || scanning} className="min-h-11 rounded-field border border-field bg-surface px-4 font-bold hover:border-primary disabled:opacity-60">
                {suggesting ? "AI is looking…" : "AI suggests"}
              </button>
            </form>
          )}
          <form action={scanMyArea}>
            <button type="submit" disabled={scanning} className="min-h-11 rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover disabled:opacity-60">
              {scanning ? "Scanning…" : "Scan my area"}
            </button>
          </form>
        </div>
      </div>

      {scanning && scanJob?.status === "RUNNING" && scanJob.message && <p className="font-semibold text-ink-2">{scanJob.message}</p>}
      {suggesting && suggestJob?.status === "RUNNING" && suggestJob.message && <p className="font-semibold text-ink-2">{suggestJob.message}</p>}
      {scan?.status === "FAILED" && !scanning && (
        <Notice tone="danger" title="The last scan didn't finish.">
          {scan.message}
        </Notice>
      )}
      {pitching && pitchJob?.status === "RUNNING" && pitchJob.message && <p className="font-semibold text-ink-2">{pitchJob.message}</p>}
      {recentPitchJob?.status === "DONE" && recentPitchJob.message && (
        <Notice tone="green" title="Pitches written.">
          {recentPitchJob.message}. <Link href="/inbox?tab=catering">Review them in the inbox</Link>.
        </Notice>
      )}
      {recentPitchJob?.status === "FAILED" && (
        <Notice tone="danger" title="Pitches weren't written.">
          {recentPitchJob.message}
        </Notice>
      )}
      {suggestJob?.status === "FAILED" && !suggesting && (
        <Notice tone="danger" title="AI suggestions didn't finish.">
          {suggestJob.message}
        </Notice>
      )}
      {scan && (
        <p className="text-sm text-muted">
          Last scan {scan.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })} · businesses from{" "}
          {scan.placesProvider === "fake" ? "sample data" : "Google"} · events from {scan.eventsProvider === "off" ? "nowhere (event search is off)" : scan.eventsProvider}
          {scan.message ? ` · ${scan.message}` : ""}
          {suggestions.at ? ` · AI suggestions from ${suggestions.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })}` : ""}
        </p>
      )}

      <nav aria-label="Leads or events" className="flex gap-2 border-b border-line">
        {[
          ["events", `Events (${eventCount})`],
          ["businesses", `Businesses (${leadCount})`],
        ].map(([v, label]) => (
          <Link
            key={v}
            href={tabHref(v)}
            aria-current={view === v ? "page" : undefined}
            className={`-mb-px min-h-11 border-b-2 px-4 py-2.5 font-bold no-underline ${view === v ? "border-primary text-primary-ink" : "border-transparent text-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface px-5 py-4">
        <input type="hidden" name="view" value={view} />
        <label className="flex min-w-[min(220px,100%)] flex-1 flex-col gap-1 text-[13px] font-bold text-muted">
          Search
          <input name="q" defaultValue={q} placeholder={view === "events" ? "Event, venue or organiser" : "Business name or street"} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Type
          <select name="type" defaultValue={view === "events" ? eventType : leadType} className={field}>
            <option value="">All types</option>
            {(view === "events" ? EVENT_TYPES : LEAD_TYPES).map((t) => (
              <option key={t} value={t}>
                {view === "events" ? cap(t) : categoryLabel(t)}
              </option>
            ))}
          </select>
        </label>
        {view === "events" ? (
          <>
            <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
              Coming up
              <select name="days" defaultValue={days} className={field}>
                <option value="7">In the next week</option>
                <option value="14">In the next 2 weeks</option>
                <option value="28">In the next 4 weeks</option>
                <option value="60">In the next 60 days</option>
                <option value="custom">Custom dates</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
              From
              <input type="date" name="from" defaultValue={from ?? ""} min={ymd(now)} className={field} aria-describedby="custom-hint" />
            </label>
            <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
              To
              <input type="date" name="to" defaultValue={to ?? ""} min={ymd(now)} max={ymd(new Date(now.getTime() + 60 * DAY_MS))} className={field} aria-describedby="custom-hint" />
            </label>
            <p id="custom-hint" className="sr-only">
              Filling in a date uses those dates instead of the period above.
            </p>
          </>
        ) : (
          <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
            Show
            <select name="status" defaultValue={status} className={field}>
              <option value="open">Not pitched yet</option>
              <option value="pitched">Pitched</option>
              <option value="excluded">Excluded</option>
              <option value="all">All</option>
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Within
          <select name="within" defaultValue={within} className={field}>
            <option value="any">Any distance</option>
            {["1", "2", "3", "5", "10"].map((m) => (
              <option key={m} value={m}>
                {m} mi
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Sort by
          <select name="sort" defaultValue={sort} className={field}>
            {view === "events" && <option value="date">Date</option>}
            <option value="fit">Best fit</option>
            <option value="distance">Closest</option>
            {view === "events" && <option value="attendance">Biggest crowd</option>}
            {view === "businesses" && <option value="name">Name</option>}
            {suggestions.byLead.size > 0 && <option value="ai">AI picks first</option>}
          </select>
        </label>
        <button type="submit" className="min-h-11 rounded-field bg-ink px-5 font-bold text-white">
          Apply
        </button>
        <Link href={tabHref(view)} className="min-h-11 px-2 py-2.5 text-sm font-bold">
          Clear
        </Link>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Tick several and write them together: one AI request covers up to 8 pitches.</p>
        <button type="submit" form="bulk" className="min-h-11 rounded-field border-2 border-primary bg-surface px-4 font-bold text-primary-ink hover:bg-primary-soft">
          Generate pitches for ticked rows
        </button>
      </div>

      {view === "events" && (
        <p className="text-sm text-muted">
          {events.length} {events.length === 1 ? "event" : "events"} between {fmtDay(window.gte < now ? now : window.gte)} and {fmtDay(window.lte)}
          {custom ? " (custom dates)" : ""}. Events less than a week away are marked short notice.
        </p>
      )}
      {view === "events" ? (
        events.length === 0 ? (
          <Card className="p-6 text-ink-2">
            {eventCount === 0
              ? scanning
                ? "Searching…"
                : "No upcoming events found yet. Click “Scan my area”; events come from a web search (with your Gemini key) and, if you add their keys, Ticketmaster and PredictHQ."
              : "No events match these filters."}
          </Card>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Events">
            {events.map((e) => {
              const daysAway = Math.round((e.startsAt.getTime() - now.getTime()) / 86_400_000);
              const ai = aiFor(e.venueLeadId, e.id);
              const existing = pitchFor(e.venueLeadId, e.id);
              return (
                <li key={e.id} className="grid gap-4 rounded-card border border-line bg-surface px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {!existing && !writing.has(e.id) && <PickBox value={`event:${e.id}`} label={e.title} />}
                      <Pill tone="sun">{cap(e.category)}</Pill>
                      {ai && <Pill tone="green">AI pick · {ai.confidence}</Pill>}
                      <span className="text-[13px] font-bold text-muted">Fit {e.fitScore}</span>
                    </span>
                    <p className="text-[17px] font-bold">{e.title}</p>
                    <p className="text-sm font-semibold text-ink-2">
                      {fmtDay(e.startsAt)} · in {daysAway} days
                      {e.attendance ? ` · ~${e.attendance.toLocaleString("en-US")} expected` : ""}
                      {e.distanceMiles != null ? ` · ${e.distanceMiles} mi` : ""}
                    </p>
                    {e.description && <p className="text-sm text-ink-2">{e.description}</p>}
                    <p className="text-sm text-ink-2">
                      {[e.venueName, e.organizer && e.organizer !== e.venueName ? `by ${e.organizer}` : null].filter(Boolean).join(" ") || "No venue listed"}
                      {" · "}
                      {e.venueLead ? `we'd pitch ${e.venueLead.name}` : "we'll look up the venue or organiser when you pitch"}
                    </p>
                    {ai && <p className="rounded-field bg-primary-soft px-3 py-2 text-sm text-primary-ink">AI: {ai.why}</p>}
                    <p className="text-[13px] text-muted">
                      Source: {SOURCE[e.source] ?? e.source}
                      {e.source === "web" ? " (check the details before pitching)" : ""}
                      {e.url && (
                        <>
                          {" · "}
                          <a href={e.url} target="_blank" rel="noreferrer" className="font-bold">
                            Event page
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {existing ? (
                      <>
                        <Link href={`/inbox?tab=catering&d=${existing.id}`} className="flex min-h-11 items-center justify-center rounded-field border-2 border-primary font-bold no-underline">
                          Open pitch
                        </Link>
                        <p className="text-[13px] font-semibold text-primary-ink">The pitch is in your inbox to review.</p>
                      </>
                    ) : (
                      <GenerateButton value={`event:${e.id}`} writing={writing.has(e.id)} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : leads.length === 0 ? (
        <Card className="p-6 text-ink-2">{leadCount === 0 ? (scanning ? "Searching…" : "No businesses yet. Click “Scan my area” to search.") : "No businesses match these filters."}</Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Businesses">
          {leads.map((l) => {
            const ai = aiFor(l.id, null);
            const existing = pitchFor(l.id, null);
            return (
              <li key={l.id} className={`grid gap-4 rounded-card border border-line bg-surface px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,260px)] ${l.status === "EXCLUDED" ? "opacity-75" : ""}`}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {!existing && !writing.has(l.id) && l.status !== "EXCLUDED" && <PickBox value={`lead:${l.id}`} label={l.name} />}
                    <Pill>{categoryLabel(l.category)}</Pill>
                    {ai && <Pill tone="green">AI pick · {ai.confidence}</Pill>}
                    <Pill tone={STATUS[l.status].tone}>
                      {STATUS[l.status].label}
                      {l.excludeReason ? ` · ${l.excludeReason}` : ""}
                    </Pill>
                  </span>
                  <p className="text-[17px] font-bold">
                    {l.name} <span className="text-sm font-semibold text-muted">· fit {l.fitScore} · {l.distanceMiles} mi</span>
                  </p>
                  <p className="text-sm break-words text-ink-2">
                    {l.address}
                    {l.source !== "event" && (
                      <>
                        {" · "}
                        <a href={mapsUrl(l.placeId, l.name)} target="_blank" rel="noreferrer" className="font-bold">
                          Open in Google Maps
                        </a>
                      </>
                    )}
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
                  {ai && <p className="rounded-field bg-primary-soft px-3 py-2 text-sm text-primary-ink">AI: {ai.why}</p>}
                  {l.contacts.length > 0 && (
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
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {l.status === "EXCLUDED" ? (
                    <form action={includeLead}>
                      <input type="hidden" name="id" value={l.id} />
                      <button type="submit" className="min-h-11 w-full rounded-field border border-field px-4 font-bold hover:border-primary">
                        Include again
                      </button>
                    </form>
                  ) : (
                    <>
                      {existing ? (
                        <>
                          <Link href={`/inbox?tab=catering&d=${existing.id}`} className="flex min-h-11 items-center justify-center rounded-field border-2 border-primary font-bold no-underline">
                            Open pitch
                          </Link>
                          <p className="text-[13px] font-semibold text-primary-ink">
                            The pitch is in your inbox{l.contacts.length ? "." : ". No contact found yet: add one before sending."}
                          </p>
                        </>
                      ) : (
                        <GenerateButton value={`lead:${l.id}`} writing={writing.has(l.id)} />
                      )}
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
                    </>
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
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}

function PickBox({ value, label }: { value: string; label: string }) {
  return (
    <label className="flex min-h-8 items-center gap-1.5 pr-1 text-[13px] font-bold text-muted">
      <input type="checkbox" name="pick" value={value} form="bulk" className="size-5 accent-[var(--color-primary)]" aria-label={`Select ${label}`} />
      Select
    </label>
  );
}

/** Submits the bulk form with just this row, so it joins any batch being written. */
function GenerateButton({ value, writing }: { value: string; writing: boolean }) {
  return writing ? (
    <button type="button" disabled className={primaryBtn}>
      Writing the pitch…
    </button>
  ) : (
    <button type="submit" form="bulk" name="one" value={value} className={primaryBtn}>
      Generate pitch
    </button>
  );
}
