import type { Contact, Draft, GmailAccount, OutboundEmail } from "@prisma/client";
import Link from "next/link";
import { followUpsOf } from "@/lib/outreach";
import { sendNowForTesting, simulateReply, startSending, stopSequence, undoDraft } from "./actions";
import { FollowUpEditor } from "./follow-up-editor";

const STEP = { FIRST: "First email", FOLLOWUP_1: "Follow-up 1", FOLLOWUP_2: "Follow-up 2" } as const;
const when = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/** The approved pitch's emails: what's scheduled, what went out, replies, and controls. */
export function Sequence({
  draft,
  account,
  fake,
}: {
  draft: Draft & { contact: Contact | null; emails: OutboundEmail[] };
  account: GmailAccount | null;
  fake: boolean;
}) {
  const emails = [...draft.emails].sort((a, b) => a.step.localeCompare(b.step) || a.createdAt.getTime() - b.createdAt.getTime());
  const live = emails.filter((e) => e.status !== "CANCELLED");
  const sentAny = emails.some((e) => e.status === "SENT");
  const scheduled = live.some((e) => e.status === "SCHEDULED");
  const followUps = followUpsOf(draft);
  const first = emails.find((e) => e.step === "FIRST" && e.status === "SENT");

  let headline: string;
  if (draft.stage === "REPLIED") headline = "They replied. Follow-ups are stopped.";
  else if (draft.stage === "UNSUBSCRIBED") headline = "They unsubscribed. Nothing more will be sent.";
  else if (draft.stage === "BOUNCED") headline = "The email bounced, so the address was added to your do-not-contact list.";
  else if (!draft.contact) headline = "Approved. Add a contact above and it starts sending.";
  else if (!account) headline = "Approved. Connect Gmail to start sending.";
  else if (!live.length) headline = "Approved, but nothing is scheduled.";
  else if (!sentAny) headline = `Approved. The first email goes out ${when(live.find((e) => e.step === "FIRST")!.scheduledFor)} from ${account.email}.`;
  else headline = `Sent from ${account.email}. Follow-ups go out unless they reply.`;

  return (
    <div className="flex flex-col gap-4 border-t border-sand bg-primary-soft px-6 py-5 text-primary-ink sm:px-7">
      <div role="status" className="flex flex-wrap items-center gap-3">
        <strong className="flex-[1_1_300px]">{headline}</strong>
        {!account && (
          <Link href="/settings/email" className="flex min-h-11 items-center rounded-field bg-primary px-4 font-bold text-white no-underline">
            Connect Gmail
          </Link>
        )}
        {account && draft.contact && !live.length && draft.stage === "NONE" && (
          <form action={startSending}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field bg-primary px-4 font-bold text-white">
              Start sending
            </button>
          </form>
        )}
        {scheduled && (
          <form action={stopSequence}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
              Stop sending
            </button>
          </form>
        )}
        {!sentAny && (
          <form action={undoDraft}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
              Undo approval
            </button>
          </form>
        )}
      </div>

      {draft.stage === "REPLIED" && draft.replySnippet && (
        <blockquote className="rounded-field border-l-4 border-primary bg-surface px-4 py-3 text-ink">
          &ldquo;{draft.replySnippet}&rdquo;
          <span className="mt-1 block text-[13px] text-muted">
            {draft.repliedAt ? when(draft.repliedAt) : ""} ·{" "}
            <Link href={`/inbox?tab=replies&d=${draft.id}`} className="font-bold">
              Handle the reply
            </Link>
          </span>
        </blockquote>
      )}

      {emails.length > 0 && (
        <ol className="flex flex-col gap-1.5 text-sm text-ink">
          {emails.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 rounded-field bg-surface px-3 py-2">
              <span>
                <strong>{STEP[e.step]}</strong> to {e.toEmail}
              </span>
              <span className="text-ink-2">
                {e.status === "SENT" ? `Sent ${when(e.sentAt!)}` : e.status === "SCHEDULED" ? `Scheduled ${when(e.scheduledFor)}` : e.status === "CANCELLED" ? "Not sent" : e.status === "FAILED" ? "Failed" : "Sending…"}
                {e.error && e.status !== "SENT" ? ` · ${e.error}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}

      {draft.contact && !["REPLIED", "UNSUBSCRIBED", "BOUNCED", "WON", "LOST"].includes(draft.stage) && (
        <details className="rounded-field bg-surface px-4 py-3 text-ink" open={!followUps.length ? undefined : true}>
          <summary className="cursor-pointer font-bold">Follow-ups (day 4 and day 10, only if there&apos;s no reply)</summary>
          <div className="mt-3">
            {followUps.length ? (
              <FollowUpEditor
                id={draft.id}
                followUps={followUps}
                locked={["FOLLOWUP_1", "FOLLOWUP_2"].map((s) => emails.some((e) => e.step === s && e.status === "SENT"))}
              />
            ) : (
              <p className="text-sm text-ink-2">The AI is writing them now; they appear here in a moment. Until then only the first email is scheduled.</p>
            )}
          </div>
        </details>
      )}

      {fake && (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="font-bold">Test mailbox:</span>
          {!first && live.some((e) => e.step === "FIRST") && (
            <form action={sendNowForTesting}>
              <input type="hidden" name="id" value={draft.id} />
              <button type="submit" className="min-h-9 rounded-field border border-primary px-3 font-bold">
                Send the first email now
              </button>
            </form>
          )}
          {first && draft.stage === "CONTACTED" && (
            <form action={simulateReply}>
              <input type="hidden" name="id" value={draft.id} />
              <button type="submit" className="min-h-9 rounded-field border border-primary px-3 font-bold">
                Pretend they replied
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
