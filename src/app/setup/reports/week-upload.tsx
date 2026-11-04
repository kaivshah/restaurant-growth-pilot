"use client";

import { useActionState, useRef, useState } from "react";
import { uploadWeek } from "../actions";

type Group = "dayPart" | "wisr" | "other";

const ACCEPT: Record<Group, string> = { dayPart: ".csv,.xlsx", wisr: ".zip,.csv,.xlsx", other: ".csv,.xlsx" };
const HINT: Record<Group, string> = {
  dayPart: "One Day Part CSV for one week",
  wisr: "The WISR zip for one week, as it downloads",
  other: "Cash In Week CSV",
};

/** One empty week: its own upload button. The file goes in as soon as it's chosen. */
export function WeekUpload({ group, label, optional = false }: { group: Group; label: string; optional?: boolean }) {
  const [state, action, pending] = useActionState(uploadWeek, undefined);
  const form = useRef<HTMLFormElement>(null);
  const id = `upload-${group}-${label.replace(/\W+/g, "-")}`;
  return (
    <li className="flex flex-col gap-2 border-t border-sand px-6 py-3.5">
      <form ref={form} action={action} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3">
        <input type="hidden" name="group" value={group} />
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10.5" fill="none" stroke="#B9B2A3" strokeWidth="2" strokeDasharray="3 3" />
        </svg>
        <div className="min-w-0">
          <p className="font-semibold">
            {label} {optional && <span className="text-sm font-normal text-muted">(optional)</span>}
          </p>
          <p className="text-[13px] text-muted">{HINT[group]}</p>
        </div>
        <label
          htmlFor={id}
          className={`flex min-h-11 cursor-pointer items-center rounded-field border-2 border-primary px-4 font-bold text-primary-ink hover:bg-primary-soft focus-within:outline-3 focus-within:outline-sun ${pending ? "pointer-events-none opacity-60" : ""}`}
        >
          {pending ? "Reading…" : "Upload"}
          <input
            id={id}
            name="files"
            type="file"
            accept={ACCEPT[group]}
            multiple={group === "wisr"}
            className="sr-only"
            disabled={pending}
            onChange={() => form.current?.requestSubmit()}
          />
        </label>
      </form>
      {state && state.results.some((r) => !r.ok) && (
        <ul className="flex flex-col gap-1 pl-10" aria-live="polite">
          {state.results
            .filter((r) => !r.ok)
            .map((r, i) => (
              <li key={i} className="rounded-field bg-danger-soft px-3 py-2 text-sm text-[#5e2121]">
                {r.fileName && <span className="font-bold break-words">{r.fileName}: </span>}
                {r.message}
              </li>
            ))}
        </ul>
      )}
    </li>
  );
}

/** After the four needed weeks: reveal one more upload slot at a time, up to the maximum. */
export function MoreWeeks({ group, next, max }: { group: Group; next: number; max: number }) {
  const [shown, setShown] = useState(false);
  if (next > max) {
    return <li className="border-t border-sand px-6 py-3 text-[13px] text-muted">That&apos;s the most: {max} weeks. Remove one to add a different week.</li>;
  }
  if (shown) return <WeekUpload group={group} label={`Week ${next}`} optional />;
  return (
    <li className="border-t border-sand px-6 py-3">
      <button type="button" onClick={() => setShown(true)} className="min-h-10 font-bold text-primary hover:text-primary-hover">
        + Add another week (up to {max})
      </button>
    </li>
  );
}
