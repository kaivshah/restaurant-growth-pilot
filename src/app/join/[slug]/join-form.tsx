"use client";

import { useActionState } from "react";
import { type JoinState, join } from "./actions";

export function JoinForm({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [state, submit, sending] = useActionState<JoinState, FormData>(join, undefined);
  const field = "h-12 rounded-field border border-field bg-surface px-3.5 text-base";

  if (state?.done) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="text-xl font-extrabold">You&apos;re on the list{state.firstName ? `, ${state.firstName}` : ""}!</p>
        {state.welcome ? (
          <>
            <p>{state.welcome.title}. Show this code at the counter:</p>
            <p className="rounded-field bg-primary-soft px-4 py-5 text-center font-mono text-3xl font-extrabold tracking-widest text-primary-ink">{state.welcome.code}</p>
            <p className="text-sm text-muted">Valid until {state.welcome.until}.{state.welcome.emailed ? " We\u2019ve emailed it to you too." : " Take a screenshot to keep it."}</p>
          </>
        ) : state.already ? (
          <p>This email already has a welcome code. Look for our email in your inbox.</p>
        ) : (
          <p>We&apos;ll email you when there&apos;s an offer.</p>
        )}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <label className="flex flex-col gap-1 font-bold">
        Email
        <input name="email" type="email" required autoComplete="email" inputMode="email" className={field} />
      </label>
      <label className="flex flex-col gap-1 font-bold">
        First name <span className="text-sm font-normal text-muted">(optional)</span>
        <input name="firstName" autoComplete="given-name" maxLength={40} className={field} />
      </label>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="consent" required className="mt-1 size-5 accent-primary" />
        <span>Yes, email me offers from {restaurantName}. I can unsubscribe any time.</span>
      </label>
      {state?.error && (
        <p role="alert" className="font-semibold text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={sending} className="min-h-[52px] rounded-field bg-primary px-6 text-lg font-bold text-white hover:bg-primary-hover disabled:opacity-60">
        {sending ? "Joining…" : "Join"}
      </button>
    </form>
  );
}
