import Link from "next/link";
import { Card } from "@/components/ui";
import { db } from "@/lib/db";
import { setStage } from "./actions";

const when = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/** Businesses that answered a pitch: read the reply in Gmail, then move the deal on. */
export async function RepliesTab({ restaurantId }: { restaurantId: string }) {
  const replies = await db.draft.findMany({
    where: { restaurantId, kind: "CATERING_PITCH", stage: "REPLIED" },
    include: { contact: true, emails: { where: { step: "FIRST" } } },
    orderBy: [{ replyHandled: "asc" }, { repliedAt: "desc" }],
  });
  if (!replies.length) {
    return (
      <Card className="flex flex-col items-start gap-3 p-8">
        <h2 className="text-xl font-bold">No replies yet</h2>
        <p className="max-w-[62ch] text-ink-2">
          When a business answers one of your pitches, it shows up here and its follow-ups stop. Replies are checked every few minutes while the worker runs. See every deal on
          the <Link href="/pipeline">Pipeline</Link>.
        </p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Replies">
      {replies.map((r) => {
        const thread = r.emails[0]?.gmailThreadId;
        return (
          <li key={r.id} className={`flex flex-col gap-3 rounded-card bg-surface px-6 py-5 ${r.replyHandled ? "border border-line opacity-80" : "border-2 border-primary"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[17px] font-bold">
                {r.title}
                <span className="text-sm font-semibold text-muted"> · {r.contact?.name ?? r.contact?.email}</span>
              </p>
              <span className="text-sm text-muted">{r.repliedAt ? when(r.repliedAt) : ""}</span>
            </div>
            <blockquote className="rounded-field border-l-4 border-primary bg-ground px-4 py-3">&ldquo;{r.replySnippet}&rdquo;</blockquote>
            <div className="flex flex-wrap items-center gap-2">
              {thread && (
                <a href={`https://mail.google.com/mail/u/0/#all/${thread}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-field bg-primary px-4 font-bold text-white no-underline">
                  Reply in Gmail
                </a>
              )}
              {(
                [
                  ["QUOTE", "I sent a quote"],
                  ["WON", "Won the order"],
                  ["LOST", "Not interested"],
                ] as const
              ).map(([stage, label]) => (
                <form key={stage} action={setStage}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="stage" value={stage} />
                  <button type="submit" className="min-h-11 rounded-field border border-field px-4 font-bold hover:border-primary">
                    {label}
                  </button>
                </form>
              ))}
              <Link href={`/inbox?tab=catering&d=${r.id}`} className="px-2 text-sm font-bold">
                Open the pitch
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
