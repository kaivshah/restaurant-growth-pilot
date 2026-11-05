"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const primaryBtn = "flex min-h-11 w-full items-center justify-center rounded-field bg-primary px-4 font-bold text-white hover:bg-primary-hover disabled:opacity-60";

/**
 * Sends pitch requests with keepalive, so they reach the server even if the
 * page is left or reloaded at once. Clicks within a few seconds of each
 * other are written together, in one batch.
 */
async function queue(values: string[]) {
  const res = await fetch("/api/pitches", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets: values }) });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't queue the pitch.");
}

export function GenerateButton({ value, writing }: { value: string; writing: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "sending" | "queued" | "error">("idle");
  if (writing || state === "queued") {
    return (
      <button type="button" disabled className={primaryBtn}>
        Writing the pitch…
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={state === "sending"}
      className={primaryBtn}
      onClick={async () => {
        setState("sending");
        try {
          await queue([value]);
          setState("queued");
          router.refresh();
        } catch {
          setState("error");
        }
      }}
    >
      {state === "sending" ? "Queuing…" : state === "error" ? "Try again" : "Generate pitch"}
    </button>
  );
}

/** "Generate pitches for ticked rows": every ticked row, in one batch. */
export function GenerateTicked() {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-3">
      {note && <span className="text-sm font-semibold text-ink-2">{note}</span>}
      <button
        type="button"
        className="min-h-11 rounded-field border-2 border-primary bg-surface px-4 font-bold text-primary-ink hover:bg-primary-soft"
        onClick={async () => {
          const boxes = [...document.querySelectorAll<HTMLInputElement>('input[name="pick"]:checked')];
          if (!boxes.length) return setNote("Tick some rows first.");
          try {
            await queue(boxes.map((b) => b.value));
            boxes.forEach((b) => (b.checked = false));
            setNote(`${boxes.length} queued: they're written together.`);
            router.refresh();
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Couldn't queue them.");
          }
        }}
      >
        Generate pitches for ticked rows
      </button>
    </span>
  );
}
