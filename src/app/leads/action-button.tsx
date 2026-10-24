"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { LeadActionState } from "./actions";

/** A one-button form for a lead action, with its result shown underneath. */
export function ActionButton({
  action,
  id,
  label,
  busyLabel,
  className,
}: {
  action: (prev: LeadActionState, form: FormData) => Promise<LeadActionState>;
  id: string;
  label: string;
  busyLabel: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={className ?? "min-h-10 rounded-field border border-field px-3 text-sm font-bold hover:border-primary disabled:opacity-60"}>
        {pending ? busyLabel : label}
      </button>
      {state?.ok && (
        <p role="status" className="text-[13px] font-semibold text-primary-ink">
          {state.ok}{" "}
          {state.href && (
            <Link href={state.href} className="font-bold">
              Open it
            </Link>
          )}
        </p>
      )}
      {state?.error && (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
