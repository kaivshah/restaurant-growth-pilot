"use client";

import { useActionState, useRef } from "react";
import { uploadReports } from "../actions";

export function UploadBox() {
  const [state, action, pending] = useActionState(uploadReports, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="flex flex-col gap-3">
      <form ref={formRef} action={action}>
        <label
          htmlFor="files"
          className="flex cursor-pointer flex-col items-center gap-2 rounded-card border-2 border-dashed border-[#9cc3a9] bg-surface px-6 py-8 text-center focus-within:outline-3 focus-within:outline-sun"
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-primary-soft" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 26 26">
              <path d="M13 17V5M8 10l5-5 5 5" stroke="#2E7D4F" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke="#2E7D4F" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-lg font-bold">{pending ? "Reading your files…" : "Choose files to upload"}</span>
          <span className="text-sm text-muted">CSV or Excel · up to 20 files · 8–12 weeks of history gives the best results</span>
          <input
            id="files"
            name="files"
            type="file"
            multiple
            accept=".csv,.xlsx,.pdf"
            className="sr-only"
            disabled={pending}
            onChange={() => formRef.current?.requestSubmit()}
          />
        </label>
      </form>

      {state && state.results.length > 0 && (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {state.results.map((r, i) => (
            <li
              key={`${r.fileName}-${i}`}
              className={`rounded-2xl px-4 py-3 text-sm ${r.ok ? "bg-primary-soft text-primary-ink" : "bg-danger-soft text-[#5e2121]"}`}
            >
              {r.fileName && <span className="font-bold break-words">{r.fileName}: </span>}
              {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
