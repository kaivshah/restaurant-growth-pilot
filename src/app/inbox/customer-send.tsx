import type { Draft } from "@prisma/client";
import Link from "next/link";
import { AUDIENCES, audienceCounts, emailable, offerResults } from "@/lib/customers";
import { db } from "@/lib/db";
import { mailFromEnv } from "@/lib/gmail";
import { sendCustomerEmailsNow, sendToCustomers, stopCustomerSends, undoDraft } from "./actions";

const when = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/** Under an approved customer offer: send it to the list, then see how it did. */
export async function CustomerSend({ draft, note }: { draft: Draft; note?: string }) {
  const how = emailable(draft);
  const [account, counts, [result], sentAny, scheduled] = await Promise.all([
    db.gmailAccount.findUnique({ where: { restaurantId: draft.restaurantId } }),
    audienceCounts(draft.restaurantId),
    offerResults(draft.restaurantId, [draft.id]),
    db.customerEmail.count({ where: { draftId: draft.id, status: "SENT" } }),
    db.customerEmail.findMany({ where: { draftId: draft.id, status: "SCHEDULED" }, orderBy: { scheduledFor: "asc" }, select: { scheduledFor: true } }),
  ]);
  const fake = mailFromEnv()?.name === "fake";

  let headline: string;
  if (how === "welcome") headline = "Approved. Everyone who joins your list gets this by email, with their own code.";
  else if (how === null) headline = "Approved. This one is for the counter (QR card or in person), so it isn't emailed.";
  else if (!account) headline = "Approved. Connect Gmail to send it to your customer list.";
  else if (scheduled.length) headline = `Sending to ${scheduled.length + sentAny} customers from ${account.email}: next one ${when(scheduled[0].scheduledFor)}, last ${when(scheduled.at(-1)!.scheduledFor)}.`;
  else if (sentAny) headline = `Sent to ${sentAny} ${sentAny === 1 ? "customer" : "customers"}.`;
  else headline = "Approved. Choose who gets it.";

  return (
    <div className="flex flex-col gap-4 border-t border-sand bg-primary-soft px-6 py-5 text-primary-ink sm:px-7">
      <div role="status" className="flex flex-wrap items-center gap-3">
        <strong className="flex-[1_1_300px]">{headline}</strong>
        {how && !account && (
          <Link href="/settings/email" className="flex min-h-11 items-center rounded-field bg-primary px-4 font-bold text-white no-underline">
            Connect Gmail
          </Link>
        )}
        {how === "welcome" && (
          <Link href="/customers/poster" className="flex min-h-11 items-center rounded-field border-2 border-primary px-4 font-bold no-underline">
            Print the QR poster
          </Link>
        )}
        {scheduled.length > 0 && (
          <form action={stopCustomerSends}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
              Stop the rest
            </button>
          </form>
        )}
        {fake && scheduled.length > 0 && (
          <form action={sendCustomerEmailsNow}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field border border-dashed border-primary px-4 text-sm font-bold">
              Send now (test mailbox)
            </button>
          </form>
        )}
        {!sentAny && (
          <form action={undoDraft}>
            <input type="hidden" name="id" value={draft.id} />
            <button type="submit" className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
              Undo
            </button>
          </form>
        )}
      </div>

      {note && <p role="status" className="rounded-field bg-surface px-4 py-3 text-sm font-semibold text-ink">{note}</p>}

      {how === "list" && account && (
        <form action={sendToCustomers} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 text-ink">
          <input type="hidden" name="id" value={draft.id} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-bold">{result ? "Send to more people" : "Send to"}</legend>
            {AUDIENCES.map((a, i) => (
              <label key={a.key} className="flex items-start gap-3 rounded-field border border-line px-3 py-2.5">
                <input type="radio" name="audience" value={a.key} defaultChecked={i === 0} className="mt-1 size-4 accent-primary" />
                <span>
                  <span className="font-semibold">
                    {a.label} <span className="text-muted">· {counts[a.key]}</span>
                  </span>
                  <span className="block text-[13px] text-muted">{a.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-[13px] text-muted">
            Each person gets their own code. Emails go out between 10 am and 7 pm, about a minute apart, up to your daily limit. People who already got this offer are skipped.
          </p>
          <button type="submit" disabled={counts.all === 0} className="min-h-12 self-start rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover disabled:opacity-50">
            Send to customers
          </button>
          {counts.all === 0 && (
            <p className="text-sm">
              Nobody on your list yet. <Link href="/customers">Add customers or print the sign-up QR</Link>.
            </p>
          )}
        </form>
      )}

      {result && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3 text-ink">
          {[
            ["Codes given", result.codes],
            ["Emails sent", result.sent],
            ["Waiting to send", result.scheduled],
            ["Codes used", result.redeemed],
            ["Use rate", result.rate === null ? "–" : `${result.rate}%`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl border border-line bg-surface p-3">
              <dt className="text-[13px] font-bold text-muted">{k}</dt>
              <dd className="text-xl font-extrabold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
