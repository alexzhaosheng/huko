/**
 * server/task/pipeline/llm-call.ts
 *
 * The LLM call step of the task loop.
 *
 * What happens inside a single call:
 *   1. Build messages: prepend the task's system prompt to the session
 *      context, then read the live LLM context array.
 *   2. Create an empty `ai_message` draft entry so the UI immediately
 *      shows a placeholder we can stream into.
 *   3. Wire up an LLM-level AbortController. Stored on `ctx.currentLlmAbort`
 *      so `interject()` from the gateway can cancel just this call
 *      without taking down the whole task. Also forwards `ctx.masterAbort`.
 *   4. Invoke the LLM with `onPartial` — content/thinking deltas get
 *      buffered and pushed back to the UI via `update()` on the draft
 *      entry, throttled so the WebSocket doesn't drown.
 *   5. After the call returns, write the final state of the draft entry
 *      (full content + tool calls in metadata) and commit the message
 *      into the LLM context for subsequent turns.
 *   6. Accumulate token usage on TaskContext.
 *
 * Aborts: an `AbortError` thrown by `invoke()` is caught and turned into
 * a structured "aborted" outcome — TaskLoop decides whether that means
 * "the user interjected" (continue with new input) or "the task is
 * stopping" (exit cleanly).
 */

import { invoke } from "../../core/llm/invoke.js";
import type { LLMCallOptions, LLMTurnResult, PartialEvent } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";
import { EntryKind } from "../../../shared/types.js";

// ─── Result type ──────────────────────────────────────────────────────────────

export type LLMCallOutcome =
  | { kind: "ok"; entryId: number; result: LLMTurnResult }
  | { kind: "aborted"; reason: "interjected" | "stopped" };

// ─── Streaming throttle ───────────────────────────────────────────────────────

/** Min ms between WebSocket update flushes. ~30 fps is plenty for text. */
const STREAM_FLUSH_MS = 33;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function callLLM(ctx: TaskContext): Promise<LLMCallOutcome> {
  // ── 1. Build messages ────────────────────────────────────────────────────
  const messages = [
    { role: "system" as const, content: ctx.systemPrompt },
    ...ctx.sessionContext.getMessages(),
  ];

  // ── 2. Draft assistant entry for streaming UI updates ────────────────────
  const entryId = await ctx.sessionContext.appendDraft({
    taskId: ctx.taskId,
    kind: EntryKind.AiMessage,
    role: "assistant",
    content: "",
  });

  // ── 3. Abort wiring ──────────────────────────────────────────────────────
  const llmAbort = new AbortController();
  ctx.currentLlmAbort = llmAbort;
  // Forward master abort into the LLM call.
  const onMasterAbort = () => llmAbort.abort();
  if (ctx.masterAbort.signal.aborted) {
    llmAbort.abort();
  } else {
    ctx.masterAbort.signal.addEventListener("abort", onMasterAbort, { once: true });
  }

  // ── 4. Streaming buffers + throttled flush ───────────────────────────────
  let content = "";
  let thinking = "";
  let dirty = false;
  let lastFlush = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (!dirty) return;
    dirty = false;
    lastFlush = Date.now();
    // Fire-and-forget — failures are surface-level UI sync issues, not
    // task-fatal, and the final flush below is authoritative anyway.
    ctx.sessionContext
      .update({
        entryId,
        taskId: ctx.taskId,
        content,
        ...(thinking ? { metadata: { thinking }, mergeMetadata: true } : {}),
      })
      .catch(() => {
        /* swallow — best-effort streaming push */
      });
  };

  const onPartial = (e: PartialEvent) => {
    if (e.type === "content") content += e.delta;
    else if (e.type === "thinking") thinking += e.delta;
    dirty = true;

    const now = Date.now();
    if (now - lastFlush >= STREAM_FLUSH_MS) {
      flush();
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(() => {
        pendingFlush = null;
        flush();
      }, STREAM_FLUSH_MS - (now - lastFlush));
    }
  };

  // ── 5. Invoke ────────────────────────────────────────────────────────────
  let result: LLMTurnResult;
  try {
    const callOptions: LLMCallOptions = {
      protocol: ctx.protocol,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      model: ctx.modelId,
      messages,
      tools: ctx.tools,
      toolCallMode: ctx.toolCallMode,
      thinkLevel: ctx.thinkLevel,
      signal: llmAbort.signal,
      onPartial,
      ...(ctx.headers !== undefined ? { headers: ctx.headers } : {}),
      ...(ctx.extras !== undefined ? { extras: ctx.extras } : {}),
    };
    result = await invoke(callOptions);
  } catch (err: unknown) {
    if (pendingFlush) clearTimeout(pendingFlush);
    ctx.masterAbort.signal.removeEventListener("abort", onMasterAbort);
    ctx.currentLlmAbort = null;

    if (isAbort(err)) {
      // Distinguish: was this the master abort (stop), or just the LLM
      // abort (interject)?
      if (ctx.masterAbort.signal.aborted) {
        return { kind: "aborted", reason: "stopped" };
      }
      return { kind: "aborted", reason: "interjected" };
    }
    throw err;
  }

  if (pendingFlush) clearTimeout(pendingFlush);
  ctx.masterAbort.signal.removeEventListener("abort", onMasterAbort);
  ctx.currentLlmAbort = null;

  // ── 6. Final flush — authoritative DB state ──────────────────────────────
  const finalMetadata: Record<string, unknown> = {};
  if (result.thinking) finalMetadata["thinking"] = result.thinking;
  if (result.toolCalls.length > 0) finalMetadata["toolCalls"] = result.toolCalls;
  if (result.usage.totalTokens > 0) finalMetadata["usage"] = result.usage;

  await ctx.sessionContext.update({
    entryId,
    taskId: ctx.taskId,
    content: result.content,
    ...(Object.keys(finalMetadata).length > 0
      ? { metadata: finalMetadata, mergeMetadata: true }
      : {}),
  });

  // ── 7. Commit to the LLM context ─────────────────────────────────────────
  ctx.sessionContext.commitToContext({
    entryId,
    kind: EntryKind.AiMessage,
    role: "assistant",
    content: result.content,
    ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    ...(result.thinking ? { thinking: result.thinking } : {}),
  });

  // ── 8. Token accounting ──────────────────────────────────────────────────
  ctx.addTokens(result.usage);
  ctx.iterationCount += 1;

  return { kind: "ok", entryId, result };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAbort(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || /aborted/i.test(err.message);
  }
  return false;
}
