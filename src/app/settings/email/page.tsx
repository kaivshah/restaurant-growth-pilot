import { Card, Notice, Pill } from "@/components/ui";
import { db } from "@/lib/db";
import { GMAIL_SCOPES, appUrl, mailFromEnv } from "@/lib/gmail";
import { requireRestaurant } from "@/lib/restaurant";
import { AppShell } from "../../inbox/shell";
import { blockAddress, disconnectGmail, setDailyCap, unblockAddress } from "./actions";

const REASON: Record<string, string> = { unsubscribed: "Unsubscribed", bounced: "Bounced", owner: "Added by you", "replied-stop": "Asked to stop" };

export default async function EmailSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const restaurant = await requireRestaurant();
  const { connected, error } = await searchParams;
  const [account, pending, suppressed, queued] = await Promise.all([
    db.gmailAccount.findUnique({ where: { restaurantId: restaurant.id } }),
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.suppression.findMany({ where: { restaurantId: restaurant.id }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.outboundEmail.count({ where: { restaurantId: restaurant.id, status: "SCHEDULED" } }),
  ]);
  const mail = mailFromEnv();

  return (
    <AppShell settings pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Email sending</h1>
        <p className="max-w-[70ch] text-lg text-ink-2">Approved pitches go out from your own Gmail, on weekday mornings, with follow-ups on day 4 and day 10 unless the business replies.</p>
      </div>
      {connected && (
        <Notice tone="green" title="Gmail connected.">
          Approved pitches will start sending in the next slot.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" title="Gmail isn't connected.">
          {error}
        </Notice>
      )}

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-bold">Your Gmail</h2>
        {account ? (
          <>
            <p>
              Sending as <strong>{account.email}</strong>
              {mail?.name === "fake" ? <Pill tone="sun">test mailbox</Pill> : null} · connected {account.connectedAt.toLocaleDateString("en-US")} · {queued} emails scheduled
            </p>
            {account.error && (
              <Notice tone="danger" title="Sending is paused.">
                {account.error} <a href="/api/gmail/connect">Reconnect Gmail</a>
              </Notice>
            )}
            <form action={disconnectGmail}>
              <button type="submit" className="min-h-11 rounded-field border border-[#e8c9c9] px-4 font-bold text-danger">
                Disconnect Gmail
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-ink-2">
              Google will ask you to allow two things: <strong>send email on your behalf</strong> (only emails you approved) and <strong>read your email</strong> (only to spot
              replies to those emails, so follow-ups stop). While the app is in Google&apos;s testing mode you&apos;ll see an &ldquo;unverified app&rdquo; warning; choose
              Continue.
            </p>
            {mail ? (
              <a href="/api/gmail/connect" className="flex min-h-12 w-fit items-center rounded-field bg-primary px-5 font-bold text-white no-underline hover:bg-primary-hover">
                Connect Gmail
              </a>
            ) : (
              <Notice tone="danger" title="Gmail sending isn't set up on this server.">
                Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET (a Google OAuth client) and add {appUrl()}/api/gmail/callback as a redirect URI. For testing without Google, set GMAIL_PROVIDER=&quot;fake&quot;.
              </Notice>
            )}
            <p className="text-[13px] text-muted">Permissions requested: {GMAIL_SCOPES.filter((s) => s.startsWith("https")).map((s) => s.split("/").pop()).join(", ")}.</p>
          </>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-lg font-bold">When emails go out</h2>
        <p className="text-ink-2">Weekdays between 9 and 11 am San Diego time, a few minutes apart. A new Gmail sender should start small and grow, so the daily limit counts first emails and follow-ups together.</p>
        <form action={setDailyCap} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
            Most emails per day
            <input type="number" name="cap" min={1} max={100} defaultValue={restaurant.sendDailyCap} className="h-11 w-28 rounded-field border border-field bg-surface px-3" />
          </label>
          <button type="submit" className="min-h-11 rounded-field border border-field px-4 font-bold hover:border-primary">
            Save
          </button>
        </form>
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-lg font-bold">Never email these addresses</h2>
        <p className="text-ink-2">People who unsubscribed or asked to stop, addresses that bounced, and any you add. Every email also includes an unsubscribe link and your outlet&apos;s address.</p>
        <form action={blockAddress} className="flex flex-wrap gap-2">
          <input type="email" name="email" required placeholder="name@company.com" aria-label="Email address to block" className="h-11 min-w-0 flex-1 rounded-field border border-field bg-surface px-3" />
          <button type="submit" className="min-h-11 rounded-field border border-field px-4 font-bold hover:border-primary">
            Add
          </button>
        </form>
        {suppressed.length === 0 ? (
          <p className="text-sm text-muted">No one yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {suppressed.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-sand pt-1.5 text-sm">
                <span className="break-all">
                  <strong>{x.email}</strong> · {REASON[x.reason] ?? x.reason} · {x.createdAt.toLocaleDateString("en-US")}
                </span>
                {x.reason === "owner" && (
                  <form action={unblockAddress}>
                    <input type="hidden" name="id" value={x.id} />
                    <button type="submit" className="min-h-9 px-2 font-bold text-primary">
                      Remove
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
