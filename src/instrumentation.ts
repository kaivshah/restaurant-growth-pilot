/** Runs once when the web server starts: says which AI it will use. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { aiSummary } = await import("@/lib/llm/describe");
  console.log(`[web] ${aiSummary()}${process.env.JOBS_IN_WEB === "false" ? " · jobs run in the worker" : ""}`);
}
