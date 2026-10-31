"use client";

import { useActionState, useRef, useState } from "react";
import { Notice } from "@/components/ui";
import { type CopyState, rewriteDraft, saveDraftCopy } from "./actions";

const OFFER_CHIPS = ["Shorter", "Friendlier", "More playful", "Add an end date", "Also in Spanish"];

type Stamped = (CopyState & { at: number }) | undefined;

export function CopyEditor({
  id,
  copyLabel,
  headline,
  body,
  rewritesLeft,
  locked,
  maxBody = 600,
  rows = 5,
  bodyLabel = "Message",
  chips = OFFER_CHIPS,
}: {
  id: string;
  copyLabel: string;
  headline: string;
  body: string;
  rewritesLeft: number;
  locked: boolean;
  maxBody?: number;
  rows?: number;
  bodyLabel?: string;
  chips?: string[];
}) {
  // Stamp each result so the message and fields follow whichever action ran last.
  const [saved, save, saving] = useActionState<Stamped, FormData>(
    async (prev, form) => ({ ...(await saveDraftCopy(prev, form)), at: Date.now() }),
    undefined,
  );
  const [rewritten, rewrite, rewriting] = useActionState<Stamped, FormData>(
    async (prev, form) => ({ ...(await rewriteDraft(prev, form)), at: Date.now() }),
    undefined,
  );
  const [instruction, setInstruction] = useState("");
  const rewriteButton = useRef<HTMLButtonElement>(null);
  const latest = (rewritten?.at ?? 0) > (saved?.at ?? 0) ? rewritten : saved;
  // Key the fields on the latest server copy so a rewrite replaces what's shown.
  const shownHeadline = latest?.headline ?? headline;
  const shownBody = latest?.body ?? body;
  const left = rewritten?.rewritesLeft ?? rewritesLeft;
  const busy = saving || rewriting;

  return (
    <form className="flex flex-col gap-4" action={save}>
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-col gap-2">
        <label htmlFor={`headline-${id}`} className="text-sm font-bold">
          {copyLabel}
        </label>
        <input
          key={`h-${shownHeadline}`}
          id={`headline-${id}`}
          name="headline"
          defaultValue={shownHeadline}
          maxLength={90}
          disabled={locked}
          className="h-12 rounded-field border border-field bg-surface px-4 disabled:bg-ground"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`body-${id}`} className="text-sm font-bold">
          {bodyLabel}
        </label>
        <textarea
          key={`b-${shownBody}`}
          id={`body-${id}`}
          name="body"
          defaultValue={shownBody}
          rows={rows}
          maxLength={maxBody}
          disabled={locked}
          className="rounded-field border border-field bg-surface px-4 py-3.5 leading-relaxed disabled:bg-ground"
        />
        <p className="text-[13px] text-muted">
          Every email adds your name, the outlet&apos;s address, &ldquo;independently owned and operated&rdquo; and an unsubscribe link.
          {body.includes("[CODE]") && " [CODE] becomes each customer's redemption code."}
        </p>
      </div>

      {!locked && (
        <>
          <div className="flex flex-col gap-3 rounded-2xl bg-ground p-4">
            <p className="text-sm font-bold">
              Edit with AI <span className="font-semibold text-muted">· {left} {left === 1 ? "rewrite" : "rewrites"} left</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setInstruction(c)}
                  aria-pressed={instruction === c}
                  className="min-h-10 rounded-full border border-field bg-surface px-3.5 text-sm font-semibold hover:border-primary aria-pressed:border-2 aria-pressed:border-primary aria-pressed:text-primary-ink"
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <label htmlFor={`instr-${id}`} className="sr-only">
                Tell the AI what to change
              </label>
              <input
                id={`instr-${id}`}
                name="instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                // Enter means "rewrite", not the form's default "save".
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (instruction.trim() && rewriteButton.current && !rewriteButton.current.disabled) e.currentTarget.form?.requestSubmit(rewriteButton.current);
                }}
                placeholder="Or type what to change"
                maxLength={300}
                className="h-12 rounded-field border border-field bg-surface px-4"
              />
              <button
                ref={rewriteButton}
                type="submit"
                formAction={rewrite}
                disabled={busy || left <= 0}
                className="min-h-12 rounded-field border-2 border-primary bg-surface px-5 font-bold text-primary-ink disabled:opacity-60"
              >
                {rewriting ? "Rewriting…" : "Rewrite"}
              </button>
            </div>
          </div>

          {rewriting && <p className="text-[13px] text-muted">Rewriting… this takes a few seconds, or up to a minute with a local model.</p>}
          {(latest?.error || latest?.ok) && (
            <Notice tone={latest?.error ? "danger" : "green"}>{latest?.error ?? latest?.ok}</Notice>
          )}

          <div>
            <button type="submit" disabled={busy} className="min-h-12 rounded-field border border-field bg-surface px-5 font-bold hover:border-primary disabled:opacity-60">
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
