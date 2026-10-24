import type { DraftJob } from "@prisma/client";
import { Notice } from "@/components/ui";
import { jobState } from "@/lib/drafts";
import { missingAiReason, providerFromEnv } from "@/lib/llm";
import { AutoRefresh } from "./auto-refresh";

const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/**
 * "AI isn't set up" or "AI is busy, trying again at …". While a job waits,
 * the page checks back every 30 seconds so the retry runs on time.
 */
export function AiStatus({ job }: { job: DraftJob | null }) {
  if (!providerFromEnv()) {
    return (
      <Notice tone="danger" title="AI isn't set up yet, so nothing can be written.">
        {missingAiReason()}
      </Notice>
    );
  }
  if (jobState(job) !== "waiting") return null;
  return (
    <>
      <AutoRefresh everyMs={30_000} />
      <Notice title={`The AI is busy (free limit reached). We'll try again at ${time(job!.runAfter!)}.`}>
        Keep this page open and it carries on by itself, or click the button above to try now. Drafts already written are kept.
      </Notice>
    </>
  );
}
