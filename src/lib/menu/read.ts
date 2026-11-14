import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CLAUDE_DEFAULT_MODEL, claudeClient, claudeError, fallbackParams, inputTokensOf } from "@/lib/llm/claude";
import { AiConfigError, ProviderError } from "@/lib/llm/types";
import { MENU_CATEGORIES } from "./catalogue";
import { MenuRead, readMenuCsv } from "./index";

/**
 * Reads a menu from a photo, a PDF or a CSV. Photos and PDFs go to Claude
 * with vision (one request, low effort); CSVs are parsed here. Only the
 * printed items and prices come back: nothing is invented.
 */

export const MENU_FILE_LIMIT = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

const SYSTEM = `You read a restaurant's menu board, printed menu or price list and list every item with its price, exactly as printed.
- One line per item per size. Put the size in "size" (e.g. "6-inch", "Footlong", "21 oz", "3 ft"); leave it empty when an item has one price.
- Use the price as printed in US dollars. If a size's price is unreadable, leave that line out and say so in notes.
- Pick the closest category from: ${MENU_CATEGORIES.join(", ")}. Platters, giant subs, boxed meals and bundles are Catering; write their serving note in "serves" if printed.
- Don't add items that aren't shown, and don't guess prices.`;

export type MenuReadResult = { ok: true; read: MenuRead; inputTokens: number; outputTokens: number; via: "csv" | "claude" } | { ok: false; message: string; retryable?: boolean };

export async function readMenuFile(fileName: string, data: ArrayBuffer, env: NodeJS.ProcessEnv = process.env): Promise<MenuReadResult> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "txt") {
    const r = readMenuCsv(new TextDecoder("utf-8").decode(data));
    return "error" in r ? { ok: false, message: r.error } : { ok: true, read: r, inputTokens: 0, outputTokens: 0, via: "csv" };
  }
  const image = IMAGE_TYPES[ext];
  if (!image && ext !== "pdf") return { ok: false, message: "Upload a photo (JPG, PNG, WEBP), a PDF, or a CSV with name and price columns." };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, message: "Reading a photo or PDF needs the Claude API key (ANTHROPIC_API_KEY). You can upload a CSV or type the prices instead." };

  const client = claudeClient(env.ANTHROPIC_API_KEY);
  // The owner's own model choice; menu reading is light work, so the cheaper model is fine when set.
  const model = env.MENU_MODEL || env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL;
  const b64 = Buffer.from(data).toString("base64");
  const block: Anthropic.Beta.BetaContentBlockParam = image
    ? { type: "image", source: { type: "base64", media_type: image, data: b64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: [block, { type: "text", text: "List every item and price on this menu." }] }],
      output_config: { format: betaZodOutputFormat(MenuRead), effort: "low" },
      ...fallbackParams(model),
    });
    if (response.stop_reason === "refusal") return { ok: false, message: "Claude declined to read this file." };
    if (!response.parsed_output) return { ok: false, message: "Claude couldn't read a menu from this file. Try a clearer photo.", retryable: true };
    const read = response.parsed_output as MenuRead;
    if (!read.items.length) return { ok: false, message: `No priced items were found.${read.notes ? ` ${read.notes}` : ""}` };
    return { ok: true, read, inputTokens: inputTokensOf(response.usage), outputTokens: response.usage.output_tokens, via: "claude" };
  } catch (err) {
    const e = claudeError(err);
    if (e instanceof AiConfigError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof ProviderError ? e.message : String(e), retryable: e instanceof ProviderError ? e.retryable : false };
  }
}
