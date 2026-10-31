import Link from "next/link";
import type { PipelineStage } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";
import { setStage } from "../inbox/actions";
import { AppShell } from "../inbox/shell";

const COLUMNS: { stage: PipelineStage; title: string; hint: string }[] = [
  { stage: "NONE", title: "Approved", hint: "Waiting for a contact email or Gmail before it can be sent" },
  { stage: "SCHEDULED", title: "Scheduled", hint: "Approved, first email waiting for its slot" },
  { stage: "CONTACTED", title: "Contacted", hint: "Emailed; follow-ups run until they reply" },
  { stage: "REPLIED", title: "Replied", hint: "Answer them in Gmail" },
  { stage: "QUOTE", title: "Quote sent", hint: "Waiting on their decision" },
  { stage: "WON", title: "Won", hint: "Catering order booked" },
  { stage: "LOST", title: "Lost", hint: "Not this time" },
];

/** Where the next stage buttons lead from each column. */
const MOVES: Partial<Record<PipelineStage, [PipelineStage, string][]>> = {
  CONTACTED: [["REPLIED", "They replied"], ["LOST", "Lost"]],
  REPLIED: [["QUOTE", "Quote sent"], ["WON", "Won"], ["LOST", "Lost"]],
  QUOTE: [["WON", "Won"], ["LOST", "Lost"]],
  LOST: [["CONTACTED", "Reopen"]],
};

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) : "");

export default async function PipelinePage() {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const [deals, pending, gmail] = await Promise.all([
    db.draft.findMany({
      where: { restaurantId: restaurant.id, kind: "CATERING_PITCH", status: "APPROVED" },
      include: { contact: true, emails: { where: { status: { in: ["SCHEDULED", "SENT"] } }, orderBy: { scheduledFor: "asc" } } },
      orderBy: { stageUpdatedAt: "desc" },
    }),
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.gmailAccount.findUnique({ where: { restaurantId: restaurant.id }, select: { id: true } }),
  ]);
  const closedOut = deals.filter((d) => d.stage === "UNSUBSCRIBED" || d.stage === "BOUNCED");
  const won = deals.filter((d) => d.stage === "WON").length;
  const contacted = deals.filter((d) => d.stage !== "SCHEDULED" && d.stage !== "NONE").length;
  // What an approved pitch that hasn't started sending still needs.
  const blocker = (d: (typeof deals)[number]) => (!d.contact ? "Add a contact email" : !gmail ? "Connect Gmail to send" : "Press Start sending on the pitch");

  return (
    <AppShell pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Pipeline</h1>
        <p className="text-lg text-ink-2">
          {contacted} contacted · {deals.filter((d) => ["REPLIED", "QUOTE", "WON", "LOST"].includes(d.stage)).length} replied · {won} won
        </p>
      </div>
      {deals.length === 0 ? (
        <p className="text-ink-2">
          Nothing here yet. Approve a pitch in the <Link href="/inbox?tab=catering">Approval Inbox</Link> and it appears here.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
          {COLUMNS.map((col) => {
            const items = deals.filter((d) => d.stage === col.stage);
            return (
              <section key={col.stage} aria-labelledby={`col-${col.stage}`} className="flex min-w-0 flex-col gap-2 rounded-card bg-sand/60 p-3">
                <h2 id={`col-${col.stage}`} className="px-1 font-bold">
                  {col.title} <span className="text-muted">({items.length})</span>
                </h2>
                <p className="px-1 text-[13px] text-muted">{col.hint}</p>
                {items.map((d) => {
                  const next = d.emails.find((e) => e.status === "SCHEDULED");
                  return (
                    <article key={d.id} className="flex flex-col gap-1.5 rounded-field border border-line bg-surface p-3">
                      <Link href={`/inbox?tab=${d.stage === "REPLIED" ? "replies" : "catering"}&d=${d.id}`} className="font-bold text-ink no-underline">
                        {d.title}
                      </Link>
                      <span className="text-[13px] break-words text-muted">{d.contact?.email ?? "No contact"}</span>
                      <span className="text-[13px] text-ink-2">
                        {d.stage === "NONE"
                          ? blocker(d)
                          : next
                            ? `Next email ${day(next.scheduledFor)}`
                            : d.repliedAt
                              ? `Replied ${day(d.repliedAt)}`
                              : `Updated ${day(d.stageUpdatedAt)}`}
                      </span>
                      {MOVES[col.stage] && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {MOVES[col.stage]!.map(([stage, label]) => (
                            <form key={stage} action={setStage}>
                              <input type="hidden" name="id" value={d.id} />
                              <input type="hidden" name="stage" value={stage} />
                              <button type="submit" className="min-h-9 rounded-field border border-field px-2.5 text-[13px] font-bold hover:border-primary">
                                {label}
                              </button>
                            </form>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
      {closedOut.length > 0 && (
        <p className="text-sm text-muted">
          Stopped: {closedOut.map((d) => `${d.title} (${d.stage === "BOUNCED" ? "bounced" : "unsubscribed"})`).join(", ")}.
        </p>
      )}
    </AppShell>
  );
}
