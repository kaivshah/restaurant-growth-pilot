import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { ButtonLink, Card, Logo } from "@/components/ui";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";

const NAV = [
  { href: "/inbox", label: "Approval Inbox", current: true },
  { href: "/setup/reports", label: "Reports" },
  { href: "/setup/rules", label: "Settings" },
];

function greeting(now = new Date()) {
  const h = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Los_Angeles" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function InboxPage() {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const confirmedReports = await db.reportUpload.count({ where: { restaurantId: restaurant.id, status: "CONFIRMED" } });

  const summary = [
    { n: 0, title: "Catering pitches", sub: `Offices and schools within ${restaurant.radiusMiles} mi` },
    { n: 0, title: "Customer offers", sub: "Ideas from your weekly reports" },
    { n: 0, title: "Replies waiting", sub: "We'll flag interested replies here" },
  ];

  return (
    <div className="grid min-h-screen md:grid-cols-[248px_minmax(0,1fr)]">
      <nav aria-label="Main" className="flex flex-col gap-1 border-b border-line bg-surface p-4 md:border-r md:border-b-0 md:p-6">
        <div className="px-2.5 pb-6">
          <Logo />
        </div>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            className={
              item.current
                ? "flex min-h-11 items-center rounded-field bg-primary-soft px-3.5 font-bold text-primary-ink"
                : "flex min-h-11 items-center rounded-field px-3.5 font-semibold text-ink-2 hover:bg-sand"
            }
          >
            {item.label}
          </Link>
        ))}
        <div className="mt-auto flex flex-col gap-2 border-t border-sand px-3.5 pt-4 text-sm text-muted">
          <span>
            <strong className="block text-ink">{restaurant.name}</strong>
            {restaurant.outlets[0]?.address}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button type="submit" className="min-h-11 font-semibold text-primary hover:text-primary-hover">
              Sign out
            </button>
          </form>
        </div>
      </nav>

      <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">{greeting()}</h1>
          <p className="text-lg text-ink-2">Nothing is sent until you approve it.</p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-4">
          {summary.map((s) => (
            <div key={s.title} className="flex flex-col gap-1 rounded-card border border-line bg-surface px-6 py-5">
              <span className="text-[32px] leading-tight font-extrabold tabular-nums">{s.n}</span>
              <span className="font-bold">{s.title}</span>
              <span className="text-sm text-muted">{s.sub}</span>
            </div>
          ))}
        </div>

        <Card className="flex flex-col items-start gap-3 p-8">
          <h2 className="text-xl font-bold">Your first drafts are on the way</h2>
          <p className="max-w-[62ch] text-ink-2">
            Setup is done and {confirmedReports} {confirmedReports === 1 ? "report is" : "reports are"} confirmed. Offer ideas from your reports and catering pitches to nearby
            businesses will appear here for you to approve, edit or skip.
          </p>
          <ButtonLink href="/setup/reports" variant="secondary">
            Add more weekly reports
          </ButtonLink>
        </Card>
      </main>
    </div>
  );
}
