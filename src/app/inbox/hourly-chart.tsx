type Bar = { label: string; hour24: number; sales: number };

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function HourlyChart({ bars, highlight, caption }: { bars: Bar[]; highlight: number[]; caption: string }) {
  const max = Math.max(1, ...bars.map((b) => b.sales));
  const peak = bars.reduce((a, b) => (b.sales > a.sales ? b : a), bars[0]);
  const lit = bars.filter((b) => highlight.includes(b.hour24));
  const label =
    `Sales by hour. Peak at ${peak?.label} with $${Math.round(peak?.sales ?? 0)}.` +
    (lit.length ? ` Highlighted: ${lit.map((b) => `${b.label} $${Math.round(b.sales)}`).join(", ")}.` : "");

  return (
    <figure className="mt-2 flex flex-col gap-2">
      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          <div
            role="img"
            aria-label={label}
            className="grid h-[150px] items-end gap-1.5 border-b-2 border-field"
            style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}
          >
            {bars.map((b) => (
              <div key={b.hour24} className="flex h-full flex-col items-center justify-end gap-1">
                <span className="text-[11px] font-bold text-ink-2 tabular-nums">{short(b.sales)}</span>
                <div
                  className={`w-full max-w-9 rounded-t-md ${highlight.includes(b.hour24) ? "bg-sun" : "bg-[#9cc3a9]"}`}
                  style={{ height: `${Math.max(3, Math.round((b.sales / max) * 120))}px` }}
                />
              </div>
            ))}
          </div>
          <div
            aria-hidden="true"
            className="mt-1.5 grid gap-1.5 text-center text-[11px] font-semibold text-muted"
            style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}
          >
            {bars.map((b) => (
              <span key={b.hour24}>{b.label}</span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="text-[13px] text-muted">{caption}</figcaption>
    </figure>
  );
}
