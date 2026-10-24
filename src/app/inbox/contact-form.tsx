"use client";

import { useActionState } from "react";
import { type ContactState, setPitchContact } from "./actions";

export function ContactForm({
  id,
  name,
  role,
  email,
  locked,
}: {
  id: string;
  name: string | null;
  role: string | null;
  email: string | null;
  locked: boolean;
}) {
  const [state, save, saving] = useActionState<ContactState, FormData>(setPitchContact, undefined);
  const field = "h-11 rounded-field border border-field bg-surface px-3.5 disabled:bg-ground";
  return (
    <form action={save} className="flex flex-col gap-3 rounded-2xl border border-line p-4">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold">Send to</p>
        {!email && <p className="text-[13px] font-semibold text-danger">No contact found yet. Add one before this can be sent.</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Name
          <input name="name" defaultValue={name ?? ""} disabled={locked} maxLength={80} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Role
          <input name="role" defaultValue={role ?? ""} disabled={locked} maxLength={80} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Email
          <input name="email" type="email" required defaultValue={email ?? ""} disabled={locked} className={field} />
        </label>
      </div>
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className="min-h-10 rounded-field border border-field px-4 text-sm font-bold hover:border-primary disabled:opacity-60">
            {saving ? "Saving…" : "Save contact"}
          </button>
          {state?.ok && (
            <span role="status" className="text-sm font-semibold text-primary-ink">
              {state.ok}
            </span>
          )}
          {state?.error && (
            <span role="alert" className="text-sm font-semibold text-danger">
              {state.error}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
