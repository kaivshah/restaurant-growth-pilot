import Link from "next/link";
import { signOut } from "@/auth";
import { Logo } from "@/components/ui";

const NAV = [
  { href: "/inbox", label: "Approval Inbox", key: "inbox" },
  { href: "/leads", label: "Leads & events", key: "leads" },
  { href: "/pipeline", label: "Pipeline", key: "pipeline" },
  { href: "/setup/reports", label: "Reports", key: "reports" },
  { href: "/setup/rules", label: "Settings", key: "settings" },
  { href: "/settings/email", label: "Email sending", key: "email" },
];

export function AppShell({
  current,
  pending,
  restaurantName,
  address,
  children,
}: {
  current: string;
  pending: number;
  restaurantName: string;
  address?: string;
  children: React.ReactNode;
}) {
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
            aria-current={item.key === current ? "page" : undefined}
            className={
              item.key === current
                ? "flex min-h-11 items-center justify-between rounded-field bg-primary-soft px-3.5 font-bold text-primary-ink"
                : "flex min-h-11 items-center justify-between rounded-field px-3.5 font-semibold text-ink-2 hover:bg-sand"
            }
          >
            {item.label}
            {item.key === "inbox" && pending > 0 && (
              <span className="min-w-6 rounded-full bg-sun px-2 text-center text-[13px] font-extrabold text-ink">{pending}</span>
            )}
          </Link>
        ))}
        <div className="mt-auto flex flex-col gap-2 border-t border-sand px-3.5 pt-4 text-sm text-muted">
          <span>
            <strong className="block text-ink">{restaurantName}</strong>
            {address}
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
      <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-8">{children}</main>
    </div>
  );
}
