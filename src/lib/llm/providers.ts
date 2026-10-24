import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { SYSTEM_PROMPT, rewriteRequest, writeRequest } from "./prompt";
import { parseRetryAfter } from "./retry";
import { type CopyProvider, type FactsPacket, type OfferCopy, ProviderError, type WriteResult } from "./types";
import { INDEPENDENT_LINE, LIMITS } from "./validate";

const CopySchema = z.object({
  headline: z.string(),
  body: z.string(),
});

const copyJsonSchema = {
  type: "object",
  properties: {
    headline: { type: "string", maxLength: LIMITS.headline },
    body: { type: "string", maxLength: LIMITS.pitchBody },
  },
  required: ["headline", "body"],
  additionalProperties: false,
} as const;

// ---------- Templates: free, offline, always available ----------

function templatePitch(packet: FactsPacket): OfferCopy {
  const p = packet.pitch!;
  const name = packet.restaurant.name;
  const what = `${p.occasion.charAt(0).toLowerCase()}${p.occasion.slice(1)}${p.event ? ` on ${p.event.date}` : ""}`;
  const lines = [
    `Hi ${p.contactFirstName ?? "there"},`,
    "",
    `I run ${name}, just ${p.distanceMiles} mi from ${p.company}. If you're planning ${what}, we'd love to help: sub platters, wraps and salads, delivered and set up on time.`,
    "",
    `To say hello, ${p.offer} is on us with your first catering order for ${p.minOrder} or more people.`,
    "",
    "Just reply with a date and headcount and I'll send over a menu and a quote.",
    "",
    "Thanks,",
    `The team at ${name}`,
  ];
  if (packet.restaurant.kind === "FRANCHISE") lines.push("", `${name} is ${INDEPENDENT_LINE}.`);
  const subject = p.event ? `Lunch for ${p.event.title}?` : `Team lunch for ${p.company}? ${p.offer.replace(/^a /, "A ")} on us`;
  return { headline: subject.slice(0, LIMITS.headline), body: lines.join("\n") };
}

function templateCopy(packet: FactsPacket): OfferCopy {
  if (packet.pitch) return templatePitch(packet);
  const name = packet.restaurant.name;
  switch (packet.offer.key) {
    case "welcome":
      return {
        headline: "Scan to join. Your next cookie is on us.",
        body: `Join the ${name} email list for local deals from your neighbourhood shop. We'll email your free cookie code right away. One per customer; unsubscribe any time.`,
      };
    case "afternoon-drink": {
      const deal = packet.offer.title.replace(/, 3–5 pm$/, "");
      return {
        headline: `Afternoon pick-me-up: ${deal.charAt(0).toLowerCase()}${deal.slice(1)}`,
        body: `Beat the 3 pm slump at ${name}. Any weekday from 3 to 5 pm: ${deal.charAt(0).toLowerCase()}${deal.slice(1)}. Show code [CODE] at the counter. Valid for the next 4 weeks.`,
      };
    }
    case "weekend-bread":
      return {
        headline: "This weekend: free chips with any 6-inch sub",
        body: `Saturday to Monday at ${name}, get free chips with any 6-inch sub. Show code [CODE] at the counter. Valid for the next 2 weeks.`,
      };
    default: {
      // AI-suggested offers: first fact is the title; the rest are when, how long and conditions.
      const [title, when, ...rest] = packet.facts.filter((f) => f !== "Show the code at the counter");
      const valid = rest.find((f) => f.startsWith("Valid for"));
      const code = packet.rules.codePlaceholder ? ` Show code ${packet.rules.codePlaceholder} at the counter.` : "";
      const offer = (title ?? packet.offer.title).replace(/,[^,]*$/, ""); // drop the time, it's in `when`
      return {
        headline: packet.offer.title,
        body: `${offer} at ${name}${when ? `, ${when}` : ""}.${code}${valid ? ` ${valid.replace("Valid for", "Valid for the next")}.` : ""}`,
      };
    }
  }
}

export const templateProvider: CopyProvider = {
  name: "template",
  model: "built-in",
  async write(packet) {
    return templateCopy(packet);
  },
};

// ---------- Claude (Anthropic) ----------

function anthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Claude rate limit reached", true, parseRetryAfter(err.headers?.get("retry-after")));
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Claude unavailable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("Claude API key is missing or invalid", false);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude error ${err.status}: ${err.message}`, false);
  if (err instanceof ProviderError) return err;
  return new ProviderError(err instanceof Error ? err.message : String(err), false);
}

export function anthropicProvider(apiKey: string, model: string): CopyProvider {
  // Retries are handled by withRetry so every provider behaves the same.
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  async function call(user: string, signal: AbortSignal): Promise<WriteResult> {
    try {
      const response = await client.messages.parse(
        {
          model,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: user }],
          output_config: { format: zodOutputFormat(CopySchema), effort: "low" },
        },
        { signal },
      );
      if (response.stop_reason === "refusal") throw new ProviderError("Claude declined to write this offer", false);
      if (!response.parsed_output) throw new ProviderError("Claude returned copy we couldn't read", false);
      return {
        ...response.parsed_output,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      throw anthropicError(err);
    }
  }

  return {
    name: "anthropic",
    model,
    write: (packet, signal) => call(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => call(rewriteRequest(packet, current, instruction), signal),
  };
}

// ---------- Ollama (free, runs open models such as Qwen or Llama locally) ----------

export function ollamaProvider(baseUrl: string, model: string): CopyProvider {
  async function call(user: string, signal: AbortSignal): Promise<WriteResult> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: copyJsonSchema,
          options: { temperature: 0.6 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderError(`Can't reach Ollama at ${baseUrl}. Is it running?`, true);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError(`Ollama returned ${res.status}`, true, parseRetryAfter(res.headers.get("retry-after")));
    }
    if (!res.ok) throw new ProviderError(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`, false);
    const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    const parsed = CopySchema.safeParse(safeJson(data.message?.content));
    if (!parsed.success) throw new ProviderError("The local model returned copy we couldn't read", false);
    return { ...parsed.data, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count };
  }

  return {
    name: "ollama",
    model,
    write: (packet, signal) => call(writeRequest(packet), signal),
    rewrite: (packet, current, instruction, signal) => call(rewriteRequest(packet, current, instruction), signal),
  };
}

function safeJson(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---------- Choosing a provider from the environment ----------

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): CopyProvider {
  const choice = (env.LLM_PROVIDER ?? "template").toLowerCase();
  if (choice === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      console.warn("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set; using templates.");
      return templateProvider;
    }
    return anthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-haiku-5-5");
  }
  if (choice === "ollama") {
    return ollamaProvider(env.OLLAMA_URL || "http://localhost:11434", env.OLLAMA_MODEL || "qwen2.5:7b-instruct");
  }
  return templateProvider;
}
