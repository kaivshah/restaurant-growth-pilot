import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { ButtonLink, Card, Notice } from "@/components/ui";
import { db } from "@/lib/db";
import { REWRITE_LIMIT, processDraftJobs, requeueStaleJobs } from "@/lib/drafts";
import { requireRestaurant } from "@/lib/restaurant";
import { approveDraft, refreshIdeas, setSkipReason, skipDraft, undoDraft } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { CopyEditor } from "./copy-editor";
import { HourlyChart } from "./hourly-chart";
import { AppShell } from "./shell";

const SKIP_REASONS = ["Not right for my store", "Too generous", "Wrong timing", "Brand wouldn't allow it"];

type Evidence = { kind: "hourly"; bars: { label: string; hour24: number; sales: number }[]; highlight: number[]; caption: string } | null;

function greeting(now = new Date()) {
  const h = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Los_Angeles" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Tick({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="#E4F1E8" />
        <path d="M5.5 9.3l2.3 2.3 4.7-4.7" stroke="#2E7D4F" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </span>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string; d?: string }> }) {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const { tab = "offers", d } = await searchParams;

  // Pick up any work left from a restart.
  await requeueStaleJobs();
  after(() => processDraftJobs());

  const [drafts, job] = await Promise.all([
    db.draft.findMany({
      where: { restaurantId: restaurant.id, kind: "CUSTOMER_OFFER" },
      orderBy: [{ createdAt: "asc" }],
    }),
    db.draftJob.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const pending = drafts.filter((x) => x.status === "PENDING").length;
  const working = job?.status === "QUEUED" || job?.status === "RUNNING";
  const selected = drafts.find((x) => x.id === d) ?? drafts.find((x) => x.status === "PENDING") ?? drafts[0];

  const cards = [
    { href: "/inbox?tab=catering", tab: "catering", n: 0, title: "Catering pitches", sub: `Offices and schools within ${restaurant.radiusMiles} mi` },
    { href: "/inbox?tab=offers", tab: "offers", n: pending, title: "Customer offers", sub: "Ideas from your weekly reports" },
    { href: null, tab: "replies", n: 0, title: "Replies waiting", sub: "We'll flag interested replies here" },
  ];

  return (
    <AppShell current="inbox" pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      {working && <AutoRefresh />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">{greeting()}</h1>
          <p className="text-lg text-ink-2">
            {pending > 0 ? (
              <>
                You have <strong className="text-ink">{pending} {pending === 1 ? "thing" : "things"}</strong> to review.{" "}
              </>
            ) : null}
            Nothing is sent until you approve it.
          </p>
        </div>
        <form action={refreshIdeas}>
          <button type="submit" disabled={working} className="min-h-11 rounded-field border border-field bg-surface px-4 font-bold hover:border-primary disabled:opacity-60">
            {working ? "Preparing ideas…" : "Refresh ideas"}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-4">
        {cards.map((c) => {
          const active = c.tab === tab;
          const cls = `flex flex-col gap-1 rounded-card bg-surface px-6 py-5 text-ink no-underline ${active ? "border-2 border-primary shadow-[0_8px_24px_-14px_rgb(46_125_79/0.5)]" : "border border-line"}`;
          const inner = (
            <>
              <span className="text-[32px] leading-tight font-extrabold tabular-nums">{c.n}</span>
              <span className="font-bold">{c.title}</span>
              <span className="text-sm text-muted">{c.sub}</span>
            </>
          );
          return c.href ? (
            <Link key={c.title} href={c.href} aria-current={active ? "page" : undefined} className={cls}>
              {inner}
            </Link>
          ) : (
            <div key={c.title} className={cls}>
              {inner}
            </div>
          );
        })}
      </div>

      {tab === "catering" ? (
        <Card className="flex flex-col items-start gap-3 p-8">
          <h2 className="text-xl font-bold">Catering outreach comes next</h2>
          <p className="max-w-[62ch] text-ink-2">
            The next update searches the {restaurant.radiusMiles} mi around your outlet for offices, schools and clinics, and drafts a catering pitch for each one for you to approve.
          </p>
        </Card>
      ) : (
        <>
          {job?.status === "FAILED" && (
            <Notice tone="danger" title="We couldn't prepare your offer ideas.">
              {job.message} Try &ldquo;Refresh ideas&rdquo;, and if it keeps failing, check the server log.
            </Notice>
          )}
          {drafts.length === 0 ? (
            <Card className="flex flex-col items-start gap-3 p-8">
              <h2 className="text-xl font-bold">{working ? "Preparing your offer ideas…" : "No offer ideas yet"}</h2>
              <p className="max-w-[62ch] text-ink-2">
                {working
                  ? "We're reading your confirmed reports. This page updates by itself."
                  : job?.message === "Waiting for confirmed reports."
                    ? "Confirm the numbers from your weekly reports first, then we'll suggest offers."
                    : "Your reports don't point to any offers your rules allow right now. Try adding more weeks of reports, or allow more offer types in Settings."}
              </p>
              {!working && (
                <ButtonLink href="/setup/reports" variant="secondary">
                  Go to reports
                </ButtonLink>
              )}
            </Card>
          ) : (
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
              <section aria-label="Offer ideas" className="flex flex-col gap-3">
                <p className="text-sm font-semibold text-muted">Start with the welcome offer: it builds your customer list</p>
                {drafts.map((x) => {
                  const active = x.id === selected?.id;
                  return (
                    <article
                      key={x.id}
                      className={`rounded-card bg-surface px-5 py-4 ${active ? "border-2 border-primary shadow-[0_10px_28px_-16px_rgb(46_125_79/0.55)]" : "border border-line"} ${x.status === "SKIPPED" ? "opacity-70" : ""}`}
                    >
                      <Link href={`/inbox?tab=offers&d=${x.id}`} className="flex flex-col gap-1 text-ink no-underline" aria-current={active ? "true" : undefined}>
                        <span className="self-start rounded-full bg-sun-soft px-2.5 py-0.5 text-xs font-extrabold text-sun-ink">{x.category}</span>
                        <span className="text-[17px] font-bold">{x.title}</span>
                        <span className="text-sm text-muted">{x.schedule}</span>
                      </Link>
                      {x.status === "PENDING" ? (
                        <div className="mt-3.5 grid grid-cols-3 gap-2">
                          <form action={approveDraft}>
                            <input type="hidden" name="id" value={x.id} />
                            <button type="submit" className="min-h-11 w-full rounded-field bg-primary font-bold text-white hover:bg-primary-hover">
                              Approve
                            </button>
                          </form>
                          <Link href={`/inbox?tab=offers&d=${x.id}`} className="flex min-h-11 items-center justify-center rounded-field border border-field font-bold text-ink no-underline hover:border-primary">
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
                            {x.status === "SKIPPED" ? "Skipped" : "Approved"}
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
                <section aria-label="Selected offer" className="overflow-hidden rounded-card bg-surface shadow-card">
                  <div className="flex flex-col gap-4 border-b border-sand px-6 py-6 sm:px-7">
                    <div className="flex flex-col gap-1">
                      <span className="self-start rounded-full bg-sun-soft px-2.5 py-0.5 text-xs font-extrabold text-sun-ink">{selected.category}</span>
                      <h2 className="text-2xl leading-snug font-extrabold tracking-tight">{selected.title}</h2>
                      <p className="text-[15px] text-muted">{selected.schedule}</p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-2xl bg-ground p-5">
                      <p className="text-[13px] font-bold text-muted">Why we suggest it</p>
                      <p className="text-[15px]">{selected.why}</p>
                      {(selected.evidence as Evidence)?.kind === "hourly" && (
                        <HourlyChart
                          bars={(selected.evidence as NonNullable<Evidence>).bars}
                          highlight={(selected.evidence as NonNullable<Evidence>).highlight}
                          caption={(selected.evidence as NonNullable<Evidence>).caption}
                        />
                      )}
                    </div>
                    <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3">
                      {[
                        ["Who gets it", selected.audience],
                        ["Cost to you", selected.cost],
                        ["We'll measure", selected.measure],
                      ].map(([k, v]) => (
                        <div key={k} className="flex flex-col gap-0.5 rounded-2xl border border-line p-4">
                          <dt className="text-[13px] font-bold text-muted">{k}</dt>
                          <dd className="text-[15px] font-semibold">{v}</dd>
                        </div>
                      ))}
                    </dl>
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
                    />
                    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-primary-ink">
                      {selected.checks.map((c) => (
                        <Tick key={c}>{c}</Tick>
                      ))}
                    </div>
                    <p className="text-[13px] text-muted">Written by {selected.writtenBy === "template" ? "built-in template" : selected.writtenBy}</p>
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
                          Skip this idea
                        </button>
                      </form>
                    </div>
                  )}
                  {selected.status === "APPROVED" && (
                    <div role="status" className="flex flex-wrap items-center gap-3 border-t border-sand bg-primary-soft px-6 py-5 text-primary-ink sm:px-7">
                      <strong className="flex-[1_1_300px]">Approved. Sending to your customer list arrives with email sign-ups in a later update.</strong>
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
                        <strong className="flex-[1_1_300px]">Skipped. Tell us why, and we&apos;ll suggest better ideas.</strong>
                        <form action={undoDraft}>
                          <input type="hidden" name="id" value={selected.id} />
                          <button type="submit" className="min-h-11 rounded-field border-2 border-danger px-4 font-bold">
                            Undo
                          </button>
                        </form>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {SKIP_REASONS.map((r) => (
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
      )}
    </AppShell>
  );
}
