import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Pill } from "@/components/ui";
import { audienceCounts, ensureJoinSlug, joinUrl, offerResults, welcomeOffer } from "@/lib/customers";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";
import { AppShell } from "../inbox/shell";
import { setCustomerCap, removeCustomer } from "./actions";
import { AddCustomerForm } from "./add-form";

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }) : "–");

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const { q = "" } = await searchParams;
  const slug = await ensureJoinSlug(restaurant);
  const search = q.trim().toLowerCase();

  const [pending, counts, total, unsubscribed, joinedWeek, customers, results, welcome] = await Promise.all([
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    audienceCounts(restaurant.id),
    db.customer.count({ where: { restaurantId: restaurant.id } }),
    db.customer.count({ where: { restaurantId: restaurant.id, status: "UNSUBSCRIBED" } }),
    db.customer.count({ where: { restaurantId: restaurant.id, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    db.customer.findMany({
      where: { restaurantId: restaurant.id, ...(search ? { OR: [{ email: { contains: search } }, { firstName: { contains: search, mode: "insensitive" } }] } : {}) },
      include: { _count: { select: { codes: { where: { redeemedAt: { not: null } } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    offerResults(restaurant.id),
    welcomeOffer(restaurant.id),
  ]);

  return (
    <AppShell current="customers" pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Customers</h1>
        <p className="max-w-[70ch] text-lg text-ink-2">
          Your own email list. People join by scanning the QR code at the counter, and every offer you send gives each of them a personal code you can check at the till.
        </p>
      </div>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {[
          ["On the list", counts.all],
          ["Joined this week", joinedWeek],
          ["Regulars", counts.regulars],
          ["Haven't been back", counts.lapsed],
          ["Unsubscribed", unsubscribed],
        ].map(([k, v]) => (
          <Card key={k} className="p-4">
            <dt className="text-[13px] font-bold text-muted">{k}</dt>
            <dd className="text-2xl font-extrabold tabular-nums">{v}</dd>
          </Card>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-bold">Sign-up link</h2>
          <p className="text-ink-2">
            {welcome ? (
              <>
                New sign-ups get <strong>{welcome.title.toLowerCase()}</strong> with their own code.
              </>
            ) : (
              <>
                Approve the &ldquo;welcome&rdquo; offer in the <Link href="/inbox">Approval Inbox</Link> to give new sign-ups a free cookie code.
              </>
            )}
          </p>
          <code className="rounded-field bg-ground px-3 py-2 text-sm break-all">{joinUrl(slug)}</code>
          <div className="flex flex-wrap gap-3">
            <Link href="/customers/poster" className="flex min-h-11 items-center rounded-field bg-primary px-4 font-bold text-white no-underline">
              Print the QR poster
            </Link>
            <Link href={`/join/${slug}`} target="_blank" className="flex min-h-11 items-center rounded-field border border-field px-4 font-bold no-underline">
              Open sign-up page
            </Link>
          </div>
        </Card>
        <Card className="flex flex-col gap-3 p-6">
          <h2 className="text-lg font-bold">Add a customer</h2>
          <p className="text-sm text-ink-2">Only add people who said yes to getting offers by email.</p>
          <AddCustomerForm />
        </Card>
      </div>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-lg font-bold">Offer results</h2>
        {results.length === 0 ? (
          <p className="text-ink-2">
            No offers sent yet. Approve an offer in the <Link href="/inbox">Approval Inbox</Link> and press &ldquo;Send to customers&rdquo;.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-[13px] text-muted">
                <tr>
                  <th className="py-2 pr-3">Offer</th>
                  <th className="py-2 pr-3">Sent</th>
                  <th className="py-2 pr-3 text-right">Codes</th>
                  <th className="py-2 pr-3 text-right">Emailed</th>
                  <th className="py-2 pr-3 text-right">Used</th>
                  <th className="py-2 text-right">Use rate</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.draftId} className="border-t border-sand">
                    <td className="py-2 pr-3 font-semibold">
                      <Link href={`/inbox?d=${r.draftId}`}>{r.title}</Link>
                    </td>
                    <td className="py-2 pr-3">{r.sentAt ? day(r.sentAt) : "On sign-up"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.codes}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.sent}
                      {r.scheduled ? <span className="text-muted"> (+{r.scheduled} waiting)</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.redeemed}</td>
                    <td className="py-2 text-right font-bold tabular-nums">{r.rate === null ? "–" : `${r.rate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">
            Everyone <span className="text-muted">({total})</span>
          </h2>
          <form className="flex gap-2">
            <input name="q" defaultValue={q} placeholder="Search email or name" aria-label="Search customers" className="h-10 rounded-field border border-field bg-surface px-3" />
            <button type="submit" className="min-h-10 rounded-field border border-field px-3 text-sm font-bold">
              Search
            </button>
          </form>
        </div>
        {customers.length === 0 ? (
          <p className="text-ink-2">{search ? "Nobody matches that." : "Nobody yet. Print the QR poster and put it by the till."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-[13px] text-muted">
                <tr>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Joined</th>
                  <th className="py-2 pr-3 text-right">Codes used</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="border-t border-sand">
                    <td className="py-2 pr-3 break-all">{c.email}</td>
                    <td className="py-2 pr-3">{c.firstName ?? "–"}</td>
                    <td className="py-2 pr-3">
                      {day(c.createdAt)} <span className="text-muted">· {c.source === "qr" ? "QR" : "added by you"}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c._count.codes}</td>
                    <td className="py-2 text-right">
                      {c.status === "UNSUBSCRIBED" ? (
                        <Pill tone="danger">Unsubscribed</Pill>
                      ) : (
                        <form action={removeCustomer}>
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" className="text-sm font-semibold text-danger">
                            Unsubscribe
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-lg font-bold">Daily limit for offer emails</h2>
        <p className="text-sm text-ink-2">
          Offer emails go out any day between 10 am and 7 pm, about a minute apart. A personal Gmail account can send about 500 emails a day in total, so keep this well under that.
        </p>
        <form action={setCustomerCap} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
            Emails per day
            <input name="cap" type="number" min={1} max={400} defaultValue={restaurant.customerDailyCap} className="h-11 w-28 rounded-field border border-field bg-surface px-3" />
          </label>
          <button type="submit" className="min-h-11 rounded-field border border-field px-4 font-bold">
            Save
          </button>
        </form>
      </Card>
    </AppShell>
  );
}
