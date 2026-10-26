"use client";

import { useActionState } from "react";
import { type FollowUpState, saveFollowUps } from "./actions";

export function FollowUpEditor({ id, followUps, locked }: { id: string; followUps: { day: number; body: string }[]; locked: boolean[] }) {
  const [state, save, saving] = useActionState<FollowUpState, FormData>(saveFollowUps, undefined);
  return (
    <form action={save} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      {[0, 1].map((i) => (
        <label key={i} className="flex flex-col gap-1 text-sm font-bold">
          Follow-up {i + 1}, day {[4, 10][i]}
          {locked[i] ? " (sent)" : ""}
          <textarea
            name={`followup${i + 1}`}
            defaultValue={followUps[i]?.body ?? ""}
            rows={4}
            maxLength={1200}
            disabled={locked[i]}
            className="rounded-field border border-field bg-surface px-3 py-2 font-normal disabled:bg-ground"
          />
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className="min-h-10 w-fit rounded-field border border-field px-4 text-sm font-bold hover:border-primary disabled:opacity-60">
          {saving ? "Saving…" : "Save follow-ups"}
        </button>
        <span className="text-[13px] text-muted">Empty a box to skip that follow-up.</span>
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
