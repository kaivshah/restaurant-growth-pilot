"use client";

import { useState } from "react";
import { MENU_CATEGORIES } from "@/lib/menu/catalogue";

export type Row = { id: string; category: string; name: string; size: string; price: number | null; cost: number | null; active: boolean; source: string; serves: string | null };

const cell = "h-10 w-full rounded-field border border-field bg-surface px-2 text-right tabular-nums";

/**
 * The menu as an editable table, grouped by category. Items the store
 * doesn't sell are unticked rather than deleted, so a later photo read can't
 * bring back something the owner turned off by mistake.
 */
export function MenuTable({ rows, settings }: { rows: Row[]; settings: boolean }) {
  const [showAll, setShowAll] = useState(settings);
  const [extra, setExtra] = useState(1);
  const known = MENU_CATEGORIES as readonly string[];
  const cats: string[] = [...known.filter((c) => rows.some((r) => r.category === c)), ...new Set(rows.map((r) => r.category).filter((c) => !known.includes(c)))];
  const priced = rows.filter((r) => r.active && r.price != null).length;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">
          <strong>{priced}</strong> of {rows.filter((r) => r.active).length} items have a price. The AI can only name, value or discount an item that has one.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4 accent-primary" />
          Show items without a price
        </label>
      </div>
      {cats.map((cat) => {
        const list = rows.filter((r) => r.category === cat && (showAll || r.price != null || r.source !== "SEED"));
        if (!list.length) return null;
        return (
          <section key={cat} className="overflow-hidden rounded-card border border-line">
            <h3 className="bg-ground px-4 py-2 font-bold">{cat}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-4 py-1.5 font-semibold">Sold here</th>
                    <th className="py-1.5 font-semibold">Item</th>
                    <th className="py-1.5 font-semibold">Size</th>
                    {cat === "Catering" && <th className="py-1.5 font-semibold">Serves</th>}
                    <th className="py-1.5 text-right font-semibold">Price $</th>
                    <th className="py-1.5 pr-4 text-right font-semibold">Your cost $ (optional)</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className="border-t border-sand">
                      <td className="px-4 py-1">
                        <input type="checkbox" name={`active-${r.id}`} defaultChecked={r.active} className="size-5 accent-primary" aria-label={`${r.name} ${r.size} sold here`} />
                      </td>
                      <td className="py-1 pr-2">
                        {r.name}
                        {r.source === "READ" && <span className="ml-1 rounded-full bg-primary-soft px-1.5 text-[11px] font-bold text-primary-ink">read</span>}
                      </td>
                      <td className="py-1 pr-2 text-ink-2">{r.size}</td>
                      {cat === "Catering" && <td className="py-1 pr-2 text-ink-2">{r.serves ?? ""}</td>}
                      <td className="w-28 py-1 pr-2">
                        <input name={`price-${r.id}`} defaultValue={r.price ?? ""} inputMode="decimal" placeholder="–" className={cell} aria-label={`${r.name} ${r.size} price`} />
                      </td>
                      <td className="w-32 py-1 pr-4">
                        <input name={`cost-${r.id}`} defaultValue={r.cost ?? ""} inputMode="decimal" placeholder="–" className={cell} aria-label={`${r.name} ${r.size} cost`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <section className="rounded-card border border-dashed border-field p-4">
        <p className="mb-2 font-bold">Add an item that isn&apos;t listed</p>
        <div className="flex flex-col gap-2">
          {Array.from({ length: extra }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_100px]">
              <input name={`new-name-${i}`} placeholder="Item name" className="h-10 rounded-field border border-field bg-surface px-3" aria-label="New item name" />
              <select name={`new-category-${i}`} defaultValue="Subs" className="h-10 rounded-field border border-field bg-surface px-2" aria-label="New item category">
                {MENU_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <input name={`new-size-${i}`} placeholder="Size (optional)" className="h-10 rounded-field border border-field bg-surface px-3" aria-label="New item size" />
              <input name={`new-price-${i}`} placeholder="Price $" inputMode="decimal" className={cell} aria-label="New item price" />
            </div>
          ))}
        </div>
        {extra < 5 && (
          <button type="button" onClick={() => setExtra(extra + 1)} className="mt-2 text-sm font-bold text-primary">
            + Another line
          </button>
        )}
      </section>
    </div>
  );
}
