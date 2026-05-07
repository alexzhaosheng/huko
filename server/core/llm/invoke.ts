/**
 * server/core/llm/invoke.ts
 *
 * Public entry point for LLM calls.
 *
 * Responsibilities:
 *   1. Look up the protocol adapter from `options.protocol`.
 *   2. Handle XML tool-call mode at the boundary:
 *        - pre:  inject tool definitions into the system prompt
 *        - post: parse `<function_calls>` blocks out of the response
 *   3. Hand off to the adapter and return the normalized result.
 *
 * Cross-cutting concerns intentionally NOT handled here:
 *   - Retries on transient errors → pipeline / TaskLoop
 *   - Token accumulation across turns → TaskContext
 *   - Logging / tracing → decorator at a higher level
 *
 * The function is small on purpose. It is the seam where protocol
 * dispatch and tool-call-mode normalization meet, and nothing else.
 */

import { getAdapter } from "./protocol.js";
import { injectToolsAsXml, parseXmlToolCalls } from "./xml-tools.js";
import type { LLMCallOptions, LLMTurnResult } from "./types.js";

export async function invoke(options: LLMCallOptions): Promise<LLMTurnResult> {
  const adapter = getAdapter(options.protocol);

  // ── Native mode (or no tools): straight pass-through ──────────────────────
  if (options.toolCallMode === "native" || options.tools.length === 0) {
    return adapter.call(options);
  }

  // ── XML mode: bracket the call with pre/post processing ───────────────────
  const enriched: LLMCallOptions = {
    ...options,
    messages: injectToolsAsXml(options.messages, options.tools),
    tools: [], // do not also pass them as native tools
  };

  const raw = await adapter.call(enriched);
  const parsed = parseXmlToolCalls(raw.content);

  return {
    ...raw,
    content: parsed.cleanText,
    toolCalls: [...raw.toolCalls, ...parsed.toolCalls],
  };
}
