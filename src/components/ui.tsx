import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Logo() {
  return (
    <span className="flex items-center gap-2.5 text-xl font-extrabold tracking-tight">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <rect width="30" height="30" rx="10" fill="#2E7D4F" />
        <circle cx="22" cy="8" r="4" fill="#F4C04E" />
        <path d="M8.5 15.5l4 4 8-8" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      product
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-card bg-surface shadow-card", className)}>{children}</div>;
}

const buttonBase =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-field px-6 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const variants = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "border border-field bg-surface text-ink hover:border-primary",
  quiet: "px-2 text-primary hover:text-primary-hover",
  danger: "border border-[#e8c9c9] bg-surface text-danger hover:bg-danger-soft",
};
type Variant = keyof typeof variants;

export function Button({ variant = "primary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(buttonBase, variants[variant], className)} {...props} />;
}

export function ButtonLink({ variant = "primary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(buttonBase, variants[variant], "no-underline", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-bold">
        {label}
      </label>
      {children}
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export const inputClass =
  "h-12 w-full rounded-field border border-field bg-surface px-4 text-ink placeholder:text-muted/80";

/** A selectable card for a radio or checkbox. The input stays visible. */
export function ChoiceCard({ className, children, ...input }: ComponentProps<"input"> & { children: ReactNode }) {
  return (
    <label
      htmlFor={input.id}
      className={cx(
        "flex cursor-pointer items-start gap-3 rounded-2xl border border-field bg-surface p-4",
        "has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft",
        className,
      )}
    >
      <input className="mt-0.5 size-5 shrink-0 accent-primary" {...input} />
      <span className="flex flex-col gap-0.5">{children}</span>
    </label>
  );
}

export function Pill({ tone = "sand", children }: { tone?: "sand" | "green" | "sun" | "danger"; children: ReactNode }) {
  const tones = {
    sand: "bg-sand text-ink-2",
    green: "bg-primary-soft text-primary-ink",
    sun: "bg-sun-soft text-sun-ink",
    danger: "bg-danger-soft text-danger",
  };
  return <span className={cx("inline-flex items-center rounded-full px-3 py-1 text-[13px] font-bold", tones[tone])}>{children}</span>;
}

export function Notice({ tone = "sun", title, children }: { tone?: "sun" | "green" | "danger"; title?: string; children: ReactNode }) {
  const tones = {
    sun: "bg-sun-soft text-sun-ink",
    green: "bg-primary-soft text-primary-ink",
    danger: "bg-danger-soft text-[#5e2121]",
  };
  return (
    <div role="status" className={cx("rounded-2xl px-5 py-4 text-[15px]", tones[tone])}>
      {title && <p className="mb-1 font-bold">{title}</p>}
      {children}
    </div>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#2E7D4F" />
      <path d="M7.5 12.5l3 3 6-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
