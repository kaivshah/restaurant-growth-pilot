import type { DraftJob } from "@prisma/client";
import { Notice } from "@/components/ui";
import { jobState } from "@/lib/drafts";
import { missingAiReason, providerFromEnv } from "@/lib/llm";
import { dailyBlock, nextPacificMidnight, usageToday } from "@/lib/llm/usage";
import { AutoRefresh } from "./auto-refresh";

const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const hoursUntil = (d: Date) => Math.max(1, Math.round((d.getTime() - Date.now()) / 3_600_000));

/**
 * "AI isn't set up", "today's Gemini allowance is used up", or "AI is busy,
 * trying again at …", plus how many AI requests were sent today. While a job
 * waits, the page checks back every 30 seconds so the retry runs on time.
 */
export async function AiStatus({ job }: { job: DraftJob | null }) {
  const provider = providerFromEnv();
  if (!provider) {
    return (
      <Notice tone="danger" title="AI isn't set up yet, so nothing can be written.">
        {missingAiReason()}
      </Notice>
    );
  }
  const gemini = provider.name === "gemini";
  const usage = gemini ? await usageToday("gemini") : null;
  const blocked = gemini ? await dailyBlock("gemini") : null;
  const waiting = jobState(job) === "waiting";
  return (
    <>
      {waiting && <AutoRefresh everyMs={30_000} />}
      {blocked ? (
        <Notice tone="danger" title={`Today's free Gemini allowance is used up${usage?.limit ? ` (${usage.limit} requests)` : ""}.`}>
          Nothing more is sent to the AI until midnight Pacific (in about {hoursUntil(nextPacificMidnight())} h); waiting work then carries on by itself. Browsing,
          editing and approving still work. For more requests per day, turn on billing for your Gemini key in Google AI Studio (a full run costs about a cent) or switch to
          Claude.
        </Notice>
      ) : (
        waiting && (
          <Notice title={`The AI is busy (free limit reached). We'll try again at ${time(job!.runAfter!)}.`}>
            Keep this page open and it carries on by itself, or click the button above to try now. Drafts already written are kept.
          </Notice>
        )
      )}
      {usage ? (
        <p className="text-[13px] text-muted">
          AI requests today: <strong className="text-ink-2">{usage.count}</strong>
          {usage.limit ? ` of ${usage.limit}` : ""} (Gemini {usage.limit ? "daily limit" : "free tier; the limit shows here once Google reports it"}). Scans use none, AI
          suggests uses 1, writing up to 8 pitches uses 1, offer ideas use 1–2.
        </p>
      ) : (
        <p className="text-[13px] text-muted">
          AI: <strong className="text-ink-2">{provider.name}</strong> ({provider.model}){provider.name === "ollama" ? ", on this computer, no daily limit" : ""}.
        </p>
      )}
    </>
  );
}
