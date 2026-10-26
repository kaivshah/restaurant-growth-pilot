"use client";

import { useActionState } from "react";
import { type RedeemView, redeemAction } from "./actions";

const MESSAGE: Record<string, { tone: string; text: string }> = {
  invalid: { tone: "danger", text: "That isn't a code. Codes look like K7QM-4TZ9." },
  "not-found": { tone: "danger", text: "No offer has this code. Check the letters with the customer." },
  used: { tone: "danger", text: "Already used" },
  expired: { tone: "danger", text: "This code has expired" },
  "not-yet": { tone: "sun", text: "This offer hasn't started yet" },
  ok: { tone: "green", text: "Valid" },
};

const TONE: Record<string, string> = { danger: "bg-danger-soft text-[#5e2121]", sun: "bg-sun/30 text-ink", green: "bg-primary-soft text-primary-ink" };

export function RedeemForm() {
  const [state, act, busy] = useActionState<RedeemView, FormData>(redeemAction, undefined);
  const msg = state ? MESSAGE[state.state] : null;
  const details = state?.offer ? state : null;

  return (
    <div className="flex flex-col gap-4">
      <form action={act} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 font-bold">
          Code
          <input
            name="code"
            required
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={state?.code ?? ""}
            key={state?.justUsed ? "used" : "entry"}
            placeholder="K7QM-4TZ9"
            className="h-14 rounded-field border border-field bg-surface px-4 text-center font-mono text-2xl tracking-widest uppercase"
          />
        </label>
        <button type="submit" disabled={busy} className="min-h-[52px] rounded-field border-2 border-primary px-6 text-lg font-bold text-primary-ink disabled:opacity-60">
          {busy ? "Checking…" : "Check code"}
        </button>
      </form>

      {state && msg && (
        <div role="status" className={`flex flex-col gap-2 rounded-card p-5 ${TONE[msg.tone]}`}>
          <p className="text-2xl font-extrabold">{state.justUsed ? "Done: code used" : msg.text}</p>
          {details && (
            <>
              <p className="text-lg font-semibold">{details.offer}</p>
              <p className="text-sm">
                {details.firstName ? `For ${details.firstName} · ` : ""}
                {details.redeemedAt ? `Used ${details.redeemedAt}` : `Valid until ${details.validUntil}`}
              </p>
            </>
          )}
          {state.state === "ok" && !state.justUsed && (
            <form action={act}>
              <input type="hidden" name="code" value={state.code} />
              <input type="hidden" name="use" value="1" />
              <button type="submit" disabled={busy} className="mt-2 min-h-[56px] w-full rounded-field bg-primary px-6 text-lg font-bold text-white hover:bg-primary-hover disabled:opacity-60">
                Give the offer and mark used
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
