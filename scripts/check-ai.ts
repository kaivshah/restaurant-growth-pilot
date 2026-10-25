/**
 * Checks the AI setup in .env with two small requests: one email draft and
 * one tool call, like the analyst makes. Run: npm run ai:check
 */
import { loadEnv } from "./env";

async function main() {
  loadEnv();
  const { providerFromEnv, missingAiReason, writeOfferCopy } = await import("@/lib/llm");
  const { analystFromEnv } = await import("@/lib/analyst");

  console.log(`Copywriter: LLM_PROVIDER=${process.env.LLM_PROVIDER || "gemini"}  Analyst: ANALYST_PROVIDER=${process.env.ANALYST_PROVIDER || "gemini"}  Model: ${process.env.GEMINI_MODEL || "gemini-flash-latest"}`);
  const provider = providerFromEnv();
  if (!provider) {
    console.log(`✗ No copywriter. ${missingAiReason()}`);
    process.exit(1);
  }

  let started = Date.now();
  const copy = await writeOfferCopy(provider, {
    restaurant: { name: "Test Deli", brand: null, kind: "INDEPENDENT" },
    offer: { key: "check", title: "Free cookie with any sandwich", schedule: "This week", audience: "Your email list", copyLabel: "Email subject" },
    facts: ["Free cookie with any sandwich", "Valid this week"],
    rules: { brandSafe: false, maxDiscountPct: 15, codePlaceholder: null },
  });
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  if (copy.ok) console.log(`✓ Email draft written by ${copy.writtenBy} in ${secs()}s: "${copy.copy.headline}"`);
  else console.log(`✗ Email draft failed after ${secs()}s: ${copy.message}`);

  const analyst = analystFromEnv("offers");
  if (!analyst) {
    console.log("– Analyst is off, skipping the tool-call check.");
    return;
  }
  started = Date.now();
  try {
    const session = analyst.start({
      system: "You are testing tool use. Call the tool you are given.",
      user: "Call get_store_hours for store 1.",
      tools: [{ name: "get_store_hours", description: "Opening hours of a store", inputSchema: { type: "object", properties: { store: { type: "integer" } }, required: ["store"], additionalProperties: false } }],
    });
    const turn = await session.send(null, AbortSignal.timeout(120_000));
    if (turn.toolCalls.length) console.log(`✓ Analyst ${analyst.provider}:${analyst.model} called ${turn.toolCalls[0].name}(${JSON.stringify(turn.toolCalls[0].input)}) in ${secs()}s`);
    else console.log(`✗ Analyst answered in ${secs()}s but didn't call the tool: "${turn.text.slice(0, 120)}"`);
  } catch (err) {
    console.log(`✗ Analyst request failed after ${secs()}s: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** What the app sent to the AI today, from its own logs. */
async function usageReport() {
  const { usageToday, nextPacificMidnight } = await import("@/lib/llm/usage");
  const { db } = await import("@/lib/db");
  try {
    const u = await usageToday("gemini");
    const since = new Date(Date.now() - 24 * 3_600_000);
    const byPurpose = await db.llmCall.groupBy({ by: ["purpose"], where: { provider: "gemini", createdAt: { gte: since } }, _count: true, _sum: { attempts: true } });
    console.log(`\nGemini requests today (Pacific day ${u.day}): ${u.count}${u.limit ? ` of ${u.limit} (limit reported by Google)` : " (limit not reported yet)"}`);
    if (u.exhaustedUntil && u.exhaustedUntil > new Date()) console.log(`Paused until ${nextPacificMidnight().toISOString()}: the daily quota is used up.`);
    for (const row of byPurpose) console.log(`  ${row.purpose.padEnd(14)} ${row._count} calls, ${row._sum.attempts ?? 0} requests incl. retries (last 24 h)`);
  } catch {
    console.log("\n(Usage needs the database: start Postgres to see today's counts.)");
  } finally {
    await db.$disconnect();
  }
}

main()
  .then(usageReport)
  .then(() => process.exit(0));
