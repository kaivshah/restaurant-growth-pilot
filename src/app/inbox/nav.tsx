"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The main menu, grouped by job: what to review, catering, customers, settings. */
const GROUPS: { title?: string; items: { href: string; label: string; match: string[] }[] }[] = [
  { items: [{ href: "/inbox", label: "Approval Inbox", match: ["/inbox"] }] },
  {
    title: "Catering",
    items: [
      { href: "/leads", label: "Leads & events", match: ["/leads"] },
      { href: "/pipeline", label: "Pipeline", match: ["/pipeline"] },
    ],
  },
  {
    title: "Customers",
    items: [
      { href: "/customers", label: "Customer list", match: ["/customers"] },
      { href: "/redeem", label: "Redeem a code", match: ["/redeem"] },
    ],
  },
  { items: [{ href: "/setup/restaurant", label: "Settings", match: ["/setup", "/settings"] }] },
];

/** The pages under Settings, shown as tabs at the top of each. */
export const SETTINGS_TABS = [
  { href: "/setup/restaurant", label: "Store & area" },
  { href: "/setup/reports", label: "Sales reports" },
  { href: "/setup/rules", label: "Offer rules" },
  { href: "/settings/email", label: "Email sending" },
];

const isActive = (path: string, match: string[]) => match.some((m) => path === m || path.startsWith(`${m}/`));

export function NavLinks({ pending }: { pending: number }) {
  const path = usePathname();
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map((g, gi) => (
        <div key={gi} className="flex flex-col gap-1">
          {g.title && <p className="px-3.5 pb-1 text-[12px] font-bold tracking-wide text-muted uppercase">{g.title}</p>}
          {g.items.map((item) => {
            const active = isActive(path, item.match);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "flex min-h-11 items-center justify-between rounded-field bg-primary-soft px-3.5 font-bold text-primary-ink no-underline"
                    : "flex min-h-11 items-center justify-between rounded-field px-3.5 font-semibold text-ink-2 no-underline hover:bg-sand"
                }
              >
                {item.label}
                {item.href === "/inbox" && pending > 0 && <span className="min-w-6 rounded-full bg-sun px-2 text-center text-[13px] font-extrabold text-ink">{pending}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** On phones the menu folds away; it closes again after moving to another page. */
export function MobileMenu({ pending, children }: { pending: number; children: React.ReactNode }) {
  const path = usePathname();
  return (
    <details key={path} className="group md:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-field border border-field px-3.5 font-bold [&::-webkit-details-marker]:hidden">
        <span>
          Menu
          {pending > 0 && <span className="ml-2 rounded-full bg-sun px-2 text-[13px] font-extrabold">{pending}</span>}
        </span>
        <span aria-hidden="true" className="transition group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-4 pt-4">{children}</div>
    </details>
  );
}

export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-2 border-b border-line pb-3">
      {SETTINGS_TABS.map((t) => {
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex min-h-10 items-center rounded-full bg-ink px-4 text-sm font-bold text-white no-underline"
                : "flex min-h-10 items-center rounded-full border border-field bg-surface px-4 text-sm font-semibold text-ink no-underline hover:border-primary"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
