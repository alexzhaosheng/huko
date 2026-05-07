/**
 * server/core/llm/xml-tools.ts
 *
 * XML tool-call mode support — protocol-agnostic.
 *
 * Some models do not support native function calling, or the user opts out
 * of it. In that case we:
 *
 *   1. Inject a tool catalogue into the system prompt as plain text.
 *   2. Ask the model to emit invocations inside `<function_calls>` blocks.
 *   3. Parse those blocks out of the response text afterward.
 *
 * The XML format mirrors Claude's tool-use convention so well-trained
 * models slot into it naturally:
 *
 *     <function_calls>
 *     <invoke name="tool_name">
 *     <parameter name="arg1">value</parameter>
 *     <parameter name="arg2">{"nested": "json"}</parameter>
 *     </invoke>
 *     </function_calls>
 *
 * Streaming note: while the model is generating, partial XML may be
 * emitted as `content` deltas via `onPartial`. The UI can choose to
 * either show them raw or filter `<function_calls>...</function_calls>`
 * spans on the fly. The post-processing here only runs on the final
 * fully-assembled text and is purely structural — it does not rewrite
 * what the user already saw mid-stream.
 */

import { nanoid } from "nanoid";
import type { LLMMessage, Tool, ToolCall } from "./types.js";

// ─── Pre-processing: inject tool catalogue into system prompt ────────────────

/**
 * Returns a new messages array with a tool catalogue appended to the
 * leading system message. If no system message exists, one is prepended.
 * The original array is not mutated.
 */
export function injectToolsAsXml(
  messages: LLMMessage[],
  tools: Tool[],
): LLMMessage[] {
  if (tools.length === 0) return messages;

  const catalogue = renderToolCatalogue(tools);
  const result = [...messages];
  const first = result[0];

  if (first && first.role === "system") {
    result[0] = { ...first, content: `${first.content}\n\n${catalogue}` };
  } else {
    result.unshift({ role: "system", content: catalogue });
  }
  return result;
}

function renderToolCatalogue(tools: Tool[]): string {
  const blocks = tools.map((t) =>
    [
      `<tool name="${escapeAttr(t.name)}">`,
      `<description>${escapeXml(t.description)}</description>`,
      `<parameters>${JSON.stringify(t.parameters)}</parameters>`,
      `</tool>`,
    ].join("\n"),
  );

  return [
    `# Tools`,
    ``,
    `You have access to the following tools. Invoke them by emitting an XML block exactly as shown below.`,
    ``,
    blocks.join("\n\n"),
    ``,
    `## Invocation format`,
    ``,
    `<function_calls>`,
    `<invoke name="tool_name">`,
    `<parameter name="arg_name">value</parameter>`,
    `</invoke>`,
    `</function_calls>`,
    ``,
    `Each <parameter> body is the literal value: a string, JSON object, JSON array, number, or boolean. Strings are unquoted; JSON values are written as JSON.`,
    `Multiple <invoke> blocks inside one <function_calls> block are allowed; they are dispatched in order.`,
  ].join("\n");
}

// ─── Post-processing: parse tool calls out of response text ──────────────────

/**
 * Pulls any `<function_calls>` blocks out of `text`, returning the parsed
 * calls and a cleaned-up text with the XML stripped.
 *
 * Tolerant to malformed input: missing closing tags drop that invocation,
 * but the rest of the response survives.
 */
export function parseXmlToolCalls(text: string): {
  toolCalls: ToolCall[];
  cleanText: string;
} {
  const toolCalls: ToolCall[] = [];

  for (const block of text.matchAll(/<function_calls>([\s\S]*?)<\/function_calls>/g)) {
    const body = block[1] ?? "";
    for (const inv of body.matchAll(/<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g)) {
      const name = inv[1] ?? "";
      const inner = inv[2] ?? "";
      const args: Record<string, unknown> = {};
      for (const p of inner.matchAll(/<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g)) {
        const key = p[1] ?? "";
        const raw = (p[2] ?? "").trim();
        args[key] = coerceValue(raw);
      }
      toolCalls.push({ id: `xml_${nanoid(8)}`, name, arguments: args });
    }
  }

  const cleanText = text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { toolCalls, cleanText };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Best-effort value coercion: try JSON, fall back to raw string. */
function coerceValue(raw: string): unknown {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through to raw string */
    }
  }
  return raw;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}
