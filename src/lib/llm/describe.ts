import { analystFromEnv } from "@/lib/analyst";
import { providerFromEnv } from "./providers";

/** One line saying which AI does what, printed at startup so a wrong .env is easy to spot. */
export function aiSummary(env: NodeJS.ProcessEnv = process.env): string {
  const writer = providerFromEnv(env);
  const analyst = analystFromEnv("offers", env);
  const name = (p: { provider?: string; name?: string; model: string } | null) => (p ? `${p.name ?? p.provider} (${p.model})` : "off");
  return `AI: emails written by ${name(writer)}, analysis by ${analyst ? `${analyst.provider} (${analyst.model})` : "off"}`;
}
