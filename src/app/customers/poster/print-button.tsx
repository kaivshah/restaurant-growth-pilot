"use client";

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="min-h-11 rounded-field bg-primary px-4 font-bold text-white">
      Print
    </button>
  );
}
