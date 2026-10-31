import { releaseJobsIfAiChanged } from "@/lib/drafts";
import { aiSummary } from "@/lib/llm/describe";

// Says which AI the web server will use, and frees jobs that were waiting on a different one.
console.log(`[web] ${aiSummary()}${process.env.JOBS_IN_WEB === "false" ? " · jobs run in the worker" : ""}`);
await releaseJobsIfAiChanged(aiSummary()).catch(() => 0);
