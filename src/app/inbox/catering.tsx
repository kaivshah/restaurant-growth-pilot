import Link from "next/link";
import type { DraftJob, LeadScan } from "@prisma/client";
import { Card, Notice } from "@/components/ui";
import { db } from "@/lib/db";
import { REWRITE_LIMIT, jobState } from "@/lib/drafts";
import { LEAD_SKIP_REASONS } from "@/lib/leads/score";
import { LIMITS } from "@/lib/llm/validate";
import { approveDraft, scanMyArea, setSkipReason, skipDraft, undoDraft } from "./actions";
import { ActionButton } from "../leads/action-button";
import { findContact } from "../leads/actions";
import { ContactForm } from "./contact-form";
import { CopyEditor } from "./copy-editor";
import { SourcePill, Tick, fmtValue } from "./parts";

const PITCH_CHIPS = ["Shorter", "More formal", "Friendlier", "Mention we can deliver early", "Mention dietary options"];

type PitchEvidence = {
  kind: "pitch";
  reasons: string[];
  citations: { label: string; value: number; source: string }[];
  mapsUrl: string;
  event: { title: string; date: string; attendance: number | null; url: string | null; source: string } | null;
  occasion: string;
  offer: string;
};

const OFFER_SHORT: Record<string, string> = { free_cookie_platter: "Free cookie platter", free_drinks_tray: "Free drinks tray", free_delivery: "Free delivery" };

const when = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" });

export async function CateringTab({
  restaurantId,
  radiusMiles,
  selectedId,
  job,
  scan,
}: {
  restaurantId: string;
  radiusMiles: number;
  selectedId?: string;
  job: DraftJob | null;
  scan: LeadScan | null;
}) {
  const drafts = await db.draft.findMany({
    where: { restaurantId, kind: "CATERING_PITCH" },
    include: { lead: true, contact: true },
    orderBy: [{ createdAt: "asc" }],
  });
  // Best leads first; decided ones sink to the bottom.
  drafts.sort((a, b) => Number(a.status !== "PENDING") - Number(b.status !== "PENDING") || (b.lead?.fitScore ?? 0) - (a.lead?.fitScore ?? 0));
  const working = jobState(job) === "working";
  const selected = drafts.find((x) => x.id === selectedId) ?? drafts.find((x) => x.status === "PENDING") ?? drafts[0];
  const ev = selected?.evidence as PitchEvidence | null;
  // e.g. "AI picked 6 of 88 businesses (…), 9 more added as top matches", from the scan summary
  const picked = scan?.message?.match(/AI picked [^;]*?(?=, stopped|, couldn't|;|$)|chose the top-scored leads[^;,]*/)?.[0]?.replace(/^chose/, "Chose");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-6 py-4">
        <p className="text-ink-2">
          {working ? (
            <>
              <strong className="text-ink">Scanning the {radiusMiles} mi around your store…</strong>
              {job?.status === "RUNNING" && job.message && <span className="block text-sm">{job.message}</span>}
            </>
          ) : scan ? (
            <>
              Last scan {when(scan.createdAt)}: <strong className="text-ink">{scan.leadsFound} businesses</strong>, {scan.eventsFound} upcoming events.
              {picked && <span className="block text-sm">{picked}. Pitch any other business from Leads &amp; events.</span>}
            </>
          ) : (
            "We haven't scanned your area yet."
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/leads" className="font-bold">
            See all leads & events
          </Link>
          <form action={scanMyArea}>
            <button type="submit" disabled={working} className="min-h-11 rounded-field border border-field bg-surface px-4 font-bold hover:border-primary disabled:opacity-60">
              {working ? "Scanning…" : "Scan my area"}
            </button>
          </form>
        </div>
      </div>

      {job?.status === "FAILED" && (
        <Notice tone="danger" title="The area scan didn't finish.">
          {job.message} Try &ldquo;Scan my area&rdquo; again, and if it keeps failing, check the server log.
        </Notice>
      )}

      {drafts.length === 0 ? (
        <Card className="flex flex-col items-start gap-3 p-8">
          <h2 className="text-xl font-bold">{working ? "Finding offices, schools and events near you…" : "No catering pitches yet"}</h2>
          <p className="max-w-[62ch] text-ink-2">
            {working
              ? "We're searching your area, looking up who orders food at each place, and drafting pitches. With Gemini's free plan this takes a few minutes, because it allows about 10 AI requests a minute. This page updates by itself."
              : (job?.message ?? `Click "Scan my area" to search the ${radiusMiles} mi around your store for businesses and events that order catering.`)}
          </p>
        </Card>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <section aria-label="Catering pitches" className="flex flex-col gap-3">
            <p className="text-sm font-semibold text-muted">Best matches first. Nothing is sent until you approve it.</p>
            {drafts.map((x) => {
              const active = x.id === selected?.id;
              const e = x.evidence as PitchEvidence | null;
              return (
                <article
                  key={x.id}
                  className={`rounded-card bg-surface px-5 py-4 ${active ? "border-2 border-primary shadow-[0_10px_28px_-16px_rgb(46_125_79/0.55)]" : "border border-line"} ${x.status === "SKIPPED" ? "opacity-70" : ""}`}
                >
                  <Link href={`/inbox?tab=catering&d=${x.id}`} className="flex flex-col gap-1 text-ink no-underline" aria-current={active ? "true" : undefined}>
                    <span className="flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-sun-soft px-2.5 py-0.5 text-xs font-extrabold text-sun-ink">{x.category}</span>
                      <SourcePill source={x.source} confidence={x.confidence} pitch />
                    </span>
                    <span className="text-[17px] font-bold">{x.title}</span>
                    <span className="text-sm text-muted">
                      Fit {x.lead?.fitScore ?? "–"} · {x.lead?.distanceMiles ?? "?"} mi · {OFFER_SHORT[e?.offer ?? ""] ?? "Catering offer"}
                    </span>
                    {e?.event && (
                      <span className="text-sm font-semibold text-ink-2">
                        Event: {e.event.title}, {e.event.date}
                      </span>
                    )}
                  </Link>
                  {x.status === "PENDING" ? (
                    <div className="mt-3.5 grid grid-cols-3 gap-2">
                      <form action={approveDraft}>
                        <input type="hidden" name="id" value={x.id} />
                        <button type="submit" className="min-h-11 w-full rounded-field bg-primary font-bold text-white hover:bg-primary-hover">
                          Approve
                        </button>
                      </form>
                      <Link href={`/inbox?tab=catering&d=${x.id}`} className="flex min-h-11 items-center justify-center rounded-field border border-field font-bold text-ink no-underline hover:border-primary">
                        Edit
                      </Link>
                      <form action={skipDraft}>
                        <input type="hidden" name="id" value={x.id} />
                        <button type="submit" className="min-h-11 w-full rounded-field border border-field font-bold text-muted hover:border-primary">
                          Skip
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className={`rounded-full px-3 py-1 text-[13px] font-bold ${x.status === "SKIPPED" ? "bg-danger-soft text-danger" : "bg-primary text-white"}`}>
                        {x.status === "SKIPPED" ? `Skipped${x.skipReason ? ` · ${x.skipReason}` : ""}` : "Approved"}
                      </span>
                      <form action={undoDraft}>
                        <input type="hidden" name="id" value={x.id} />
                        <button type="submit" className="min-h-10 px-3 font-bold text-primary">
                          Undo
                        </button>
                      </form>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          {selected && (
            <section aria-label="Selected pitch" className="overflow-hidden rounded-card bg-surface shadow-card">
              <div className="flex flex-col gap-4 border-b border-sand px-6 py-6 sm:px-7">
                <div className="flex flex-col gap-1">
                  <span className="flex flex-wrap gap-1.5">
                    <span className="rounded-full bg-sun-soft px-2.5 py-0.5 text-xs font-extrabold text-sun-ink">{selected.category}</span>
                    <SourcePill source={selected.source} confidence={selected.confidence} pitch />
                  </span>
                  <h2 className="text-2xl leading-snug font-extrabold tracking-tight">{selected.title}</h2>
                  <p className="text-[15px] text-muted">
                    {selected.lead?.address} · {selected.lead?.distanceMiles} mi away
                    {ev?.mapsUrl && (
                      <>
                        {" · "}
                        <a href={ev.mapsUrl} target="_blank" rel="noreferrer" className="font-bold">
                          Open in Google Maps
                        </a>
                      </>
                    )}
                  </p>
                </div>

                {ev?.event && (
                  <div className="flex flex-col gap-0.5 rounded-2xl border-2 border-sun bg-sun-soft px-5 py-4">
                    <p className="font-bold">
                      Event: {ev.event.title}, {ev.event.date}
                      {ev.event.attendance ? `, ~${ev.event.attendance.toLocaleString("en-US")} expected` : ""}
                    </p>
                    <p className="text-sm text-ink-2">
                      Reaching the venue now gives them time to plan food for staff and exhibitors.
                      {ev.event.url && (
                        <>
                          {" "}
                          <a href={ev.event.url} target="_blank" rel="noreferrer" className="font-bold">
                            Event page
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-3 rounded-2xl bg-ground p-5">
                  <p className="text-[13px] font-bold text-muted">Why this lead</p>
                  <p className="text-[15px]">{selected.why}</p>
                  {ev?.reasons?.length ? (
                    <ul className="flex flex-col gap-1 text-sm text-ink-2">
                      {ev.reasons.map((r) => (
                        <li key={r}>· {r}</li>
                      ))}
                    </ul>
                  ) : null}
                  {ev?.citations?.length ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-[13px] font-bold text-muted">Numbers the AI used, checked against the scan</p>
                      <ul className="flex flex-col gap-1.5">
                        {ev.citations.map((c, i) => (
                          <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-sand pt-1.5 text-sm">
                            <span>
                              {c.label}
                              <span className="block text-[12px] text-muted">{c.source}</span>
                            </span>
                            <span className="font-bold tabular-nums">{fmtValue(c.value)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3">
                  {[
                    ["What it's for", ev?.occasion ?? "Team lunches"],
                    ["Cost to you", selected.cost],
                    ["We'll measure", selected.measure],
                  ].map(([k, v]) => (
                    <div key={k} className="flex flex-col gap-0.5 rounded-2xl border border-line p-4">
                      <dt className="text-[13px] font-bold text-muted">{k}</dt>
                      <dd className="text-[15px] font-semibold">{v}</dd>
                    </div>
                  ))}
                </dl>

                <ContactForm
                  key={selected.id}
                  id={selected.id}
                  name={selected.contact?.name ?? null}
                  role={selected.contact?.role ?? null}
                  email={selected.contact?.email ?? null}
                  locked={selected.status !== "PENDING"}
                />
                {!selected.contact && selected.status === "PENDING" && selected.lead && (
                  <div className="-mt-1">
                    {selected.lead.contactsCheckedAt ? (
                      <p className="text-[13px] text-muted">We already searched this business&apos;s website and found no one. Add a contact above if you know who orders food.</p>
                    ) : selected.lead.website ? (
                      <ActionButton action={findContact} id={selected.lead.id} label="Find contact (1 Hunter lookup)" busyLabel="Searching…" />
                    ) : (
                      <p className="text-[13px] text-muted">No website to search. Add a contact above if you know who orders food.</p>
                    )}
                  </div>
                )}
                {selected.contact && (
                  <p className="-mt-2 text-[13px] text-muted">
                    {selected.contact.source === "owner" ? "Added by you" : `Found by ${selected.contact.source === "hunter" ? "Hunter.io" : "the test contact finder"}`}
                    {selected.contact.confidence != null ? ` · ${selected.contact.confidence}% confidence` : ""}
                    {selected.contact.verification ? ` · email check: ${selected.contact.verification.replace("_", " ")}` : ""}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-4 px-6 py-6 sm:px-7">
                <CopyEditor
                  key={selected.id}
                  id={selected.id}
                  copyLabel={selected.copyLabel}
                  headline={selected.headline}
                  body={selected.body}
                  rewritesLeft={Math.max(0, REWRITE_LIMIT - selected.rewriteCount)}
                  locked={selected.status !== "PENDING"}
                  maxBody={LIMITS.pitchBody}
                  rows={16}
                  bodyLabel="Email message"
                  chips={PITCH_CHIPS}
                />
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-primary-ink">
                  {selected.checks.map((c) => (
                    <Tick key={c}>{c}</Tick>
                  ))}
                </div>
                <p className="text-[13px] text-muted">
                  Written by {selected.writtenBy === "template" ? "built-in template" : selected.writtenBy}
                  {selected.analysisRunId && (
                    <>
                      {" · "}
                      <Link href={`/inbox/analysis/${selected.analysisRunId}`} className="font-bold">
                        See how the AI chose
                      </Link>
                    </>
                  )}
                </p>
              </div>

              {selected.status === "PENDING" && (
                <div className="flex flex-wrap gap-3 border-t border-sand bg-[#fcfbf7] px-6 py-5 sm:px-7">
                  <form action={approveDraft}>
                    <input type="hidden" name="id" value={selected.id} />
                    <button type="submit" className="min-h-[52px] rounded-field bg-primary px-6 font-bold text-white hover:bg-primary-hover">
                      Approve
                    </button>
                  </form>
                  <form action={skipDraft} className="ml-auto">
                    <input type="hidden" name="id" value={selected.id} />
                    <button type="submit" className="min-h-[52px] rounded-field border border-[#e8c9c9] bg-surface px-5 font-bold text-danger">
                      Skip this lead
                    </button>
                  </form>
                </div>
              )}
              {selected.status === "APPROVED" && (
                <div role="status" className="flex flex-wrap items-center gap-3 border-t border-sand bg-primary-soft px-6 py-5 text-primary-ink sm:px-7">
                  <strong className="flex-[1_1_300px]">
                    Approved. It will send from your Gmail once sending is turned on.
                    {!selected.contact && " Add a contact first, or it can't be sent."}
                  </strong>
                  <form action={undoDraft}>
                    <input type="hidden" name="id" value={selected.id} />
                    <button type="submit" className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
                      Undo
                    </button>
                  </form>
                </div>
              )}
              {selected.status === "SKIPPED" && (
                <div role="status" className="flex flex-col gap-3 border-t border-sand bg-danger-soft px-6 py-5 text-[#5e2121] sm:px-7">
                  <div className="flex flex-wrap items-center gap-3">
                    <strong className="flex-[1_1_300px]">Skipped. Tell us why. Unless the contact was wrong, we won&apos;t pitch this business again.</strong>
                    <form action={undoDraft}>
                      <input type="hidden" name="id" value={selected.id} />
                      <button type="submit" className="min-h-11 rounded-field border-2 border-danger px-4 font-bold">
                        Undo
                      </button>
                    </form>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {LEAD_SKIP_REASONS.map((r) => (
                      <form key={r} action={setSkipReason}>
                        <input type="hidden" name="id" value={selected.id} />
                        <input type="hidden" name="reason" value={r} />
                        <button
                          type="submit"
                          aria-pressed={selected.skipReason === r}
                          className={`min-h-10 rounded-full px-3.5 text-sm font-semibold ${selected.skipReason === r ? "border border-danger bg-danger text-white" : "border border-[#e8c9c9] bg-surface"}`}
                        >
                          {r}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
