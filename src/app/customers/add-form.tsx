"use client";

import { useActionState } from "react";
import { type AddState, addCustomer } from "./actions";

export function AddCustomerForm() {
  const [state, add, adding] = useActionState<AddState, FormData>(addCustomer, undefined);
  const field = "h-11 rounded-field border border-field bg-surface px-3.5";
  return (
    <form action={add} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          Email
          <input name="email" type="email" required className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-bold text-muted">
          First name (optional)
          <input name="firstName" maxLength={40} className={field} />
        </label>
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" name="consent" required className="mt-0.5 size-4 accent-primary" />
        They agreed to get offers from us by email.
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={adding} className="min-h-11 rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover disabled:opacity-60">
          {adding ? "Adding…" : "Add customer"}
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
    </form>
  );
}
