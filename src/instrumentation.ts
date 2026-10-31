/** Runs once when the web server starts. */
export async function register() {
  // Node-only code lives in its own file so the edge build never includes it.
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
