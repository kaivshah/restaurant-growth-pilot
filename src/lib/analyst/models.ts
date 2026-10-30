import Anthropic from "@anthropic-ai/sdk";
import { AiConfigError, ProviderError } from "@/lib/llm";
import { type GeminiContent, geminiGenerate, replyText, resolvedModel, usage } from "@/lib/llm/gemini";
import { ollamaOptions } from "@/lib/llm/providers";
import { parseRetryAfter } from "@/lib/llm/retry";
import type { ToolSpec } from "./tools";

/**
 * A provider-neutral conversation with tools. The run loop (run.ts) owns the
 * tool budget, logging and checks; each model only has to send turns.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface Turn {
  toolCalls: ToolCall[];
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnalystSession {
  /** First call: send(null). Then send the results of the previous turn's tool calls, or a nudge. */
  send(input: ToolResult[] | { nudge: string } | null, signal: AbortSignal): Promise<Turn>;
}

export interface AnalystModel {
  provider: string;
  model: string;
  start(opts: { system: string; user: string; tools: ToolSpec[] }): AnalystSession;
}

// ---------- Claude ----------

/** Models that support server-side refusal fallbacks with "default" routing. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Claude rate limit reached", true, parseRetryAfter(err.headers?.get("retry-after")));
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Claude unavailable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("Claude API key is missing or invalid", false);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude error ${err.status}: ${err.message}`, false);
  return new ProviderError(err instanceof Error ? err.message : String(err), false);
}

export function claudeAnalyst(apiKey: string, model: string, effort?: "low" | "medium" | "high" | "xhigh" | "max"): AnalystModel {
  // Retries are handled by the run loop so every provider behaves the same.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    provider: "anthropic",
    model,
    start({ system, user, tools }) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [];
      const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));
      return {
        async send(input, signal) {
          if (input === null) messages.push({ role: "user", content: user });
          else if ("nudge" in input) messages.push({ role: "user", content: input.nudge });
          else {
            // All results for one turn go back in a single user message.
            messages.push({
              role: "user",
              content: input.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
            });
          }
          try {
            const useFallbacks = FALLBACK_MODELS.has(model);
            const response = await client.beta.messages.create(
              {
                model,
                max_tokens: 16000,
                system,
                tools: toolDefs,
                messages,
                // Each turn resends the whole conversation; caching the prefix makes every turn after the first
                // read the tools, instructions and earlier tool results from cache (about a tenth of the price).
                cache_control: { type: "ephemeral" },
                ...(effort ? { output_config: { effort } } : {}),
                ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
              },
              { signal },
            );
            if (response.stop_reason === "refusal") throw new ProviderError("Claude declined to analyse this data", false);
            // Keep the assistant turn exactly as returned (including thinking blocks).
            messages.push({ role: "assistant", content: response.content });
            return {
              toolCalls: response.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
              text: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
              inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
              outputTokens: response.usage.output_tokens,
            };
          } catch (err) {
            // Drop the user turn we just added so a retry resends it cleanly.
            messages.pop();
            throw toProviderError(err);
          }
        },
      };
    },
  };
}

// ---------- Ollama (local open models with tool calling, e.g. qwen2.5) ----------

type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }
  | { role: "tool"; content: string; tool_name: string };

export function ollamaAnalyst(baseUrl: string, model: string): AnalystModel {
  return {
    provider: "ollama",
    model,
    start({ system, user, tools }) {
      const messages: OllamaMessage[] = [{ role: "system", content: system }];
      const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      let n = 0;
      return {
        async send(input, signal) {
          const added: OllamaMessage[] =
            input === null
              ? [{ role: "user", content: user }]
              : "nudge" in input
                ? [{ role: "user", content: input.nudge }]
                : input.map((r) => ({ role: "tool" as const, content: r.content, tool_name: r.name }));
          messages.push(...added);
          let res: Response;
          try {
            res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal,
              body: JSON.stringify({ model, stream: false, messages, tools: toolDefs, keep_alive: "30m", options: ollamaOptions(0.3) }),
            });
          } catch (err) {
            messages.splice(messages.length - added.length, added.length);
            if (signal.aborted) throw err;
            throw new ProviderError(`Can't reach Ollama at ${baseUrl}. Is it running?`, true);
          }
          if (!res.ok) {
            messages.splice(messages.length - added.length, added.length);
            if (res.status === 404) throw new AiConfigError(`Ollama doesn't have the model "${model}". Run: ollama pull ${model}`);
            throw new ProviderError(`Ollama returned ${res.status}`, res.status === 429 || res.status >= 500, parseRetryAfter(res.headers.get("retry-after")));
          }
          const data = (await res.json()) as {
            message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
            prompt_eval_count?: number;
            eval_count?: number;
          };
          const msg = data.message ?? {};
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
          return {
            toolCalls: (msg.tool_calls ?? []).map((c) => ({
              id: `call_${++n}`,
              name: c.function.name,
              input: typeof c.function.arguments === "string" ? safeJson(c.function.arguments) : c.function.arguments,
            })),
            text: msg.content ?? "",
            inputTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
          };
        },
      };
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------- Gemini (free tier via Google AI Studio) ----------

export function geminiAnalyst(apiKey: string, model: string): AnalystModel {
  return {
    provider: "gemini",
    get model() {
      return resolvedModel(model);
    },
    start({ system, user, tools }) {
      const contents: GeminiContent[] = [];
      const declarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }));
      let n = 0;
      return {
        async send(input, signal) {
          const added: GeminiContent =
            input === null
              ? { role: "user", parts: [{ text: user }] }
              : "nudge" in input
                ? { role: "user", parts: [{ text: input.nudge }] }
                : { role: "user", parts: input.map((r) => ({ functionResponse: { ...(r.id.startsWith("gem_") ? {} : { id: r.id }), name: r.name, response: asObject(r.content, r.isError) } })) };
          contents.push(added);
          try {
            const res = await geminiGenerate(
              apiKey,
              model,
              { systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: declarations }], generationConfig: { temperature: 0.3 } },
              signal,
            );
            const content = res.candidates?.[0]?.content ?? { role: "model" as const, parts: [] };
            // Keep the model's turn exactly as returned, including thought signatures.
            contents.push({ role: "model", parts: content.parts ?? [] });
            return {
              toolCalls: (content.parts ?? []).flatMap((p) =>
                p.functionCall ? [{ id: p.functionCall.id ?? `gem_${++n}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }] : [],
              ),
              text: replyText(res),
              ...usage(res),
            };
          } catch (err) {
            // Drop the turn we just added so a retry resends it cleanly.
            contents.pop();
            throw err;
          }
        },
      };
    },
  };
}

/** Gemini wants each tool result as a JSON object. */
function asObject(content: string, isError?: boolean): Record<string, unknown> {
  if (isError) return { error: content };
  const parsed = safeJson(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length ? (parsed as Record<string, unknown>) : { result: content };
}
