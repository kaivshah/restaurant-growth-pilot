"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { LeadActionState } from "./actions";

/** A one-button form for a lead or event action, with its result shown underneath. */
export function ActionButton({
  action,
  id,
  fields,
  label,
  busyLabel,
  className,
}: {
  action: (prev: LeadActionState, form: FormData) => Promise<LeadActionState>;
  id?: string;
  /** Extra hidden fields sent with the form */
  fields?: Record<string, string>;
  label: string;
  busyLabel: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="flex flex-col gap-1">
      {id && <input type="hidden" name="id" value={id} />}
      {Object.entries(fields ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
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
