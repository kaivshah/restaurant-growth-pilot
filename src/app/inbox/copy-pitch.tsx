"use client";

import { useState } from "react";

/** Approved while email sending is off: copy the email and send it from your own mail. */
export function CopyPitch({ subject, body, to }: { subject: string; body: string; to: string | null }) {
  const [copied, setCopied] = useState<"" | "email" | "subject">("");
  const copy = async (what: "email" | "subject") => {
    try {
      await navigator.clipboard.writeText(what === "subject" ? subject : `${body}`);
      setCopied(what);
    } catch {
      setCopied("");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => copy("email")} className="min-h-11 rounded-field bg-primary px-4 font-bold text-white hover:bg-primary-hover">
        {copied === "email" ? "Email copied" : "Copy email"}
      </button>
      <button type="button" onClick={() => copy("subject")} className="min-h-11 rounded-field border-2 border-primary px-4 font-bold">
        {copied === "subject" ? "Subject copied" : "Copy subject"}
      </button>
      {to && (
        <a href={`mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`} className="min-h-11 py-2.5 font-bold">
          Open in my email app
        </a>
      )}
    </div>
  );
}
