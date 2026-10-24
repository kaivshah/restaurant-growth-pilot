export const fmtValue = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function SourcePill({ source, confidence, pitch = false }: { source: string; confidence: string | null; pitch?: boolean }) {
  return source === "AI_ANALYST" ? (
    <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-extrabold text-primary-ink">
      {pitch ? "AI pick" : "AI idea"}
      {confidence ? ` · ${confidence} confidence` : ""}
    </span>
  ) : (
    <span className="rounded-full bg-sand px-2.5 py-0.5 text-xs font-bold text-ink-2">{pitch ? "Top match" : "Standard idea"}</span>
  );
}

export function Tick({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="#E4F1E8" />
        <path d="M5.5 9.3l2.3 2.3 4.7-4.7" stroke="#2E7D4F" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </span>
  );
}
