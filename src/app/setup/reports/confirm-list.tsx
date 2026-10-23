"use client";

import { useState } from "react";

type Item = { key: string; label: string; display: string };

export function ConfirmList({ numbers }: { numbers: Item[] }) {
  const [wrong, setWrong] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setWrong((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col">
      <ul className="tabular-nums">
        {numbers.map((n) => (
          <li key={n.key}>
            <input type="hidden" name="shown" value={n.key} />
            <label htmlFor={`ok-${n.key}`} className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-t border-sand py-3">
              <input
                id={`ok-${n.key}`}
                type="checkbox"
                name="ok"
                value={n.key}
                checked={!wrong.has(n.key)}
                onChange={() => toggle(n.key)}
                className="size-5 accent-primary"
              />
              <span className="text-ink-2">{n.label}</span>
              <span className="font-bold">{n.display}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="pt-2 text-sm text-muted">
        {wrong.size === 0
          ? "Untick anything that looks wrong."
          : `${wrong.size} ${wrong.size === 1 ? "number" : "numbers"} marked as wrong. We'll ask you to upload those reports again.`}
      </p>
    </div>
  );
}
