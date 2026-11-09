"use client";

import { useState } from "react";

export type ConfirmRow = { end: string; label: string; cells: string[] };

/**
 * Every uploaded week's main numbers side by side, with the average the AI
 * uses. Untick a week whose numbers look wrong: its reports are marked and
 * left out until they're uploaded again.
 */
export function ConfirmWeeks({ columns, weeks, average }: { columns: string[]; weeks: ConfirmRow[]; average: ConfirmRow | null }) {
  const [wrong, setWrong] = useState<Set<string>>(new Set());
  const toggle = (end: string) =>
    setWrong((prev) => {
      const next = new Set(prev);
      if (next.has(end)) next.delete(end);
      else next.add(end);
      return next;
    });
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 pr-2 font-semibold">Looks right</th>
              <th className="py-2 pr-2 font-semibold">Week</th>
              {columns.map((c) => (
                <th key={c} className="py-2 pl-2 text-right font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.end} className={`border-t border-sand ${wrong.has(w.end) ? "bg-danger-soft" : ""}`}>
                <td className="py-2 pr-2">
                  <input type="hidden" name="shownWeek" value={w.end} />
                  <input type="checkbox" name="okWeek" value={w.end} checked={!wrong.has(w.end)} onChange={() => toggle(w.end)} className="size-5 accent-primary" aria-label={`${w.label} looks right`} />
                </td>
                <td className="py-2 pr-2 whitespace-nowrap">{w.label}</td>
                {w.cells.map((c, i) => (
                  <td key={i} className="py-2 pl-2 text-right">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
            {average && (
              <tr className="border-t-2 border-ink/20 font-bold">
                <td />
                <td className="py-2 pr-2 whitespace-nowrap">{average.label}</td>
                {average.cells.map((c, i) => (
                  <td key={i} className="py-2 pl-2 text-right">
                    {c}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        {wrong.size === 0
          ? "Untick a week whose numbers look wrong."
          : `${wrong.size} ${wrong.size === 1 ? "week" : "weeks"} marked as wrong: we'll ask you to upload ${wrong.size === 1 ? "it" : "them"} again, and the AI leaves ${wrong.size === 1 ? "it" : "them"} out until then.`}
      </p>
    </div>
  );
}
