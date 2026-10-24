import type { ZodType, ZodTypeDef } from "zod";
import { ProviderError } from "@/lib/llm/types";
import { type RetryOptions, withRetry } from "@/lib/llm/retry";
import type { AnalystModel, ToolResult } from "./models";
import type { ToolDef } from "./tools";
import type { ToolLog } from "./verify";

export interface RunLimits {
  /** Most data-tool calls per run */
  maxToolCalls?: number;
  /** Most model turns per run */
  maxTurns?: number;
  /** Stop when the run has read this many input tokens in total */
  maxInputTokens?: number;
  retry?: RetryOptions;
}

export interface LoopResult<S> {
  status: "DONE" | "FAILED";
  error?: string;
  /** Set when the model was busy or over its limit, so the job can try again later */
  busy?: { retryAfterMs?: number };
  submission?: S;
  toolLog: ToolLog;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LoopConfig<C, S> {
  system: string;
  user: string;
  ctx: C;
  tools: ToolDef<unknown, C>[];
  submit: { name: string; description: string; jsonSchema: Record<string, unknown>; schema: ZodType<S, ZodTypeDef, unknown> };
  limits?: RunLimits;
}

/**
 * Runs a tool-use conversation: the model calls read-only tools until it
 * calls the submit tool with a valid result. Owns the tool and turn budgets,
 * the token cap, retries, and the log of every tool result (used later to
 * check the numbers the model cites).
 */
export async function runToolLoop<C, S>(model: AnalystModel, cfg: LoopConfig<C, S>): Promise<LoopResult<S>> {
  const limits = cfg.limits ?? {};
  const maxToolCalls = limits.maxToolCalls ?? 12;
  const maxTurns = limits.maxTurns ?? 16;
  const maxInputTokens = limits.maxInputTokens ?? 400_000;
  const byName = new Map(cfg.tools.map((t) => [t.name, t]));
  const out: LoopResult<S> = { status: "FAILED", toolLog: [], toolCalls: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
  const fail = (error: string): LoopResult<S> => ({ ...out, status: "FAILED", error });

  const session = model.start({
    system: cfg.system,
    user: cfg.user,
    tools: [
      ...cfg.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      { name: cfg.submit.name, description: cfg.submit.description, inputSchema: cfg.submit.jsonSchema },
    ],
  });

  let input: Parameters<typeof session.send>[0] = null;
  let nudges = 0;
  let badSubmits = 0;

  while (out.turns < maxTurns) {
    out.turns++;
    let turn;
    try {
      const current = input;
      ({ value: turn } = await withRetry((signal) => session.send(current, signal), { timeoutMs: 120_000, ...limits.retry }));
    } catch (err) {
      const busy = !(err instanceof ProviderError) || err.retryable ? { retryAfterMs: err instanceof ProviderError ? err.retryAfterMs : undefined } : undefined;
      return { ...fail(err instanceof Error ? err.message : String(err)), busy };
    }
    out.inputTokens += turn.inputTokens;
    out.outputTokens += turn.outputTokens;
    if (out.inputTokens > maxInputTokens) return fail(`Stopped at the token budget (${maxInputTokens.toLocaleString("en-US")} input tokens).`);

    if (turn.toolCalls.length === 0) {
      if (nudges >= 2) return fail("The analyst stopped without submitting an analysis.");
      nudges++;
      input = { nudge: `Please finish by calling ${cfg.submit.name}.` };
      continue;
    }

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      if (call.name === cfg.submit.name) {
        const parsed = cfg.submit.schema.safeParse(call.input);
        if (parsed.success) return { ...out, status: "DONE", submission: parsed.data };
        badSubmits++;
        if (badSubmits >= 3) return fail("The analyst's submission didn't match the required format.");
        const issues = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        results.push({ id: call.id, name: call.name, content: `Not accepted. Fix these and call ${cfg.submit.name} again: ${issues}`, isError: true });
        continue;
      }
      const tool = byName.get(call.name);
      if (!tool) {
        results.push({ id: call.id, name: call.name, content: `There is no tool called ${call.name}.`, isError: true });
        continue;
      }
      if (out.toolCalls >= maxToolCalls) {
        results.push({ id: call.id, name: call.name, content: `Tool budget used up. Call ${cfg.submit.name} now.`, isError: true });
        continue;
      }
      try {
        const output = tool.run(cfg.ctx, tool.parse(call.input ?? {}));
        out.toolCalls++;
        out.toolLog.push({ id: call.id, name: call.name, input: call.input, output });
        results.push({ id: call.id, name: call.name, content: JSON.stringify(output) });
      } catch (err) {
        results.push({ id: call.id, name: call.name, content: `Bad input: ${err instanceof Error ? err.message : String(err)}`, isError: true });
      }
    }
    input = results;
  }
  return fail(`Stopped after ${maxTurns} turns without a submission.`);
}
