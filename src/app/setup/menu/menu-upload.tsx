"use client";

import { useActionState, useRef } from "react";
import { Notice } from "@/components/ui";
import { readMenu } from "./actions";

/** One button: pick a photo, PDF or CSV and it's read straight away. */
export function MenuUpload({ aiOn }: { aiOn: boolean }) {
  const [state, action, pending] = useActionState(readMenu, undefined);
  const form = useRef<HTMLFormElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <form ref={form} action={action} className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="menu-file"
          className={`flex min-h-12 cursor-pointer items-center rounded-field bg-primary px-5 font-bold text-white hover:bg-primary-hover focus-within:outline-3 focus-within:outline-sun ${pending ? "pointer-events-none opacity-60" : ""}`}
        >
          {pending ? "Reading your menu…" : "Upload a menu photo, PDF or CSV"}
          <input id="menu-file" name="file" type="file" accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.csv" className="sr-only" disabled={pending} onChange={() => form.current?.requestSubmit()} />
        </label>
        <span className="text-sm text-muted">{aiOn ? "A phone photo of the menu board works. Prices are read onto the list below for you to check." : "Photos and PDFs need the Claude API key; a CSV with name and price columns works without it."}</span>
      </form>
      {pending && <p className="text-sm font-semibold text-ink-2">Reading the prices takes 10–30 seconds…</p>}
      {state?.ok && (
        <Notice tone="green" title="Menu read.">
          {state.ok}
          {state.notes ? ` Note: ${state.notes}` : ""}
        </Notice>
      )}
      {state?.error && (
        <Notice tone="danger" title="Couldn't read that.">
          {state.error}
        </Notice>
      )}
    </div>
  );
}
