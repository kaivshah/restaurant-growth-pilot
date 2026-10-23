"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const STEPS = [
  { href: "/setup/restaurant", label: "Restaurant & area", minutes: "About 10 minutes" },
  { href: "/setup/reports", label: "Sales reports", minutes: "About 5 minutes left" },
  { href: "/setup/menu", label: "Menu & catering", minutes: "About 3 minutes left" },
  { href: "/setup/rules", label: "Brand rules & email", minutes: "Almost done" },
] as const;

export function StepProgress() {
  const pathname = usePathname();
  const current = Math.max(0, STEPS.findIndex((s) => pathname.startsWith(s.href)));
  return (
    <span>
      Step {current + 1} of {STEPS.length} · {STEPS[current].minutes}
    </span>
  );
}

export function Stepper({ hasRestaurant }: { hasRestaurant: boolean }) {
  const pathname = usePathname();
  const current = Math.max(0, STEPS.findIndex((s) => pathname.startsWith(s.href)));

  return (
    <nav aria-label="Setup steps" className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3">
      {STEPS.map((step, i) => {
        const state = i < current ? "done" : i === current ? "now" : i === current + 1 ? "next" : "later";
        const reachable = hasRestaurant || i === 0;
        const box =
          state === "now"
            ? "border-2 border-sun bg-sun-soft"
            : state === "done"
              ? "bg-primary-soft text-primary-ink"
              : "border border-line bg-surface";
        const content = (
          <>
            <span
              className={
                state === "done" || state === "now"
                  ? "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white"
                  : "flex size-8 shrink-0 items-center justify-center rounded-full bg-sand text-sm font-bold text-muted"
              }
            >
              {state === "done" ? (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7.5l2.6 2.6L11 4.6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span>
              <span className={state === "now" ? "block text-xs font-semibold text-sun-ink" : "block text-xs text-muted"}>
                {state === "done" ? "Done" : state === "now" ? "Now" : state === "next" ? "Next" : "Later"}
              </span>
              <span className={state === "now" ? "block font-bold" : "block font-semibold"}>{step.label}</span>
            </span>
          </>
        );
        const cls = `flex items-center gap-3 rounded-2xl px-4 py-3 text-ink no-underline ${box}`;
        return state === "now" || !reachable ? (
          <div key={step.href} className={cls} aria-current={state === "now" ? "step" : undefined}>
            {content}
          </div>
        ) : (
          <Link key={step.href} href={step.href} className={cls}>
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
