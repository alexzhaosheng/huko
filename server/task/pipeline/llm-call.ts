/**
 * server/task/pipeline/llm-call.ts
 *
 * The LLM call step of the task loop.
 *
 * What happens inside a single call:
 *   1. Build messages: system prompt + session LLM context.
 *   2. `appendDraft` an empty assistant entry → triggers `assistant_started`
 *      HukoEvent and gives us an entryId for streaming.
 *   3. Wire dual abort signals (master + currentLlmAbort).
 *   4. Invoke the LLM with `onPartial`. Each delta is emitted DIRECTLY
 *      as a `HukoEvent` (`assistant_content_delta` / `assistant_thinking_delta`)
 *      via `sessionContext.emit(...)`. The DB row is throttled-synced.
 *   5. Drain any in-flight partial flush (race-safe even on async backends).
 *   6. After the call returns, write the final state via `update({final:true})`
 *      — that triggers `assistant_complete` emit.
 *   7. `commitToContext` — push to LLM context for next turn.
 *   8. Token bookkeeping.
 *
 * Aborts: an `AbortError` becomes `{kind:"aborted", reason:"stopped"|"interjected"}`.
 * The TaskLoop decides what that means.
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

/** Min ms between DB writes during streaming. The wire deltas are not throttled. */
const DB_FLUSH_MS = 100;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function callLLM(ctx: TaskContext): Promise<LLMCallOutcome> {
  const sc = ctx.sessionContext;

  // ── 1. Build messages ────────────────────────────────────────────────────
  const messages = [
    { role: "system" as const, content: ctx.systemPrompt },
    ...sc.getMessages(),
  ];

  // ── 2. Draft assistant entry — emits `assistant_started` ─────────────────
  const entryId = await sc.appendDraft({
    taskId: ctx.taskId,
    kind: EntryKind.AiMessage,
    role: "assistant",
    content: "",
  });

  // ── 3. Abort wiring ──────────────────────────────────────────────────────
  const llmAbort = new AbortController();
  ctx.currentLlmAbort = llmAbort;
  const onMasterAbort = () => llmAbort.abort();
  if (ctx.masterAbort.signal.aborted) {
    llmAbort.abort();
  } else {
    ctx.masterAbort.signal.addEventListener("abort", onMasterAbort, { once: true });
  }

  // ── 4. Streaming buffers + throttled DB sync ─────────────────────────────
  let content = "";
  let thinking = "";
  let dbDirty = false;
  let lastDbFlush = 0;
  let pendingDbFlush: ReturnType<typeof setTimeout> | null = null;
  /**
   * The most recent in-flight partial flush. We await this before the
   * final update so an async-DB backend (e.g. Postgres over TCP) can
   * never reorder a stale partial write AFTER the authoritative final
   * write. With today's synchronous backends (Memory / SqlitePersistence
   * via better-sqlite3) the work is already done by the time this
   * promise is created, so the await is a no-op fast path.
   */
  let inflightFlush: Promise<void> | null = null;

  const flushDb = (): void => {
    if (!dbDirty) return;
    dbDirty = false;
    lastDbFlush = Date.now();
    inflightFlush = sc
      .update({
        entryId,
        taskId: ctx.taskId,
        content,
        ...(thinking ? { metadata: { thinking }, mergeMetadata: true } : {}),
      })
      .catch(() => {
        /* swallow — DB sync is best-effort during streaming; final flush is authoritative */
      });
  };

  const onPartial = (e: PartialEvent): void => {
    if (e.type === "content") {
      content += e.delta;
      sc.emit({
        type: "assistant_content_delta",
        entryId,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        sessionType: ctx.sessionType,
        delta: e.delta,
      });
    } else {
      thinking += e.delta;
      sc.emit({
        type: "assistant_thinking_delta",
        entryId,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        sessionType: ctx.sessionType,
        delta: e.delta,
      });
    }
    dbDirty = true;

    const now = Date.now();
    if (now - lastDbFlush >= DB_FLUSH_MS) {
      flushDb();
    } else if (!pendingDbFlush) {
      pendingDbFlush = setTimeout(() => {
        pendingDbFlush = null;
        flushDb();
      }, DB_FLUSH_MS - (now - lastDbFlush));
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
    if (pendingDbFlush) clearTimeout(pendingDbFlush);
    ctx.masterAbort.signal.removeEventListener("abort", onMasterAbort);
    ctx.currentLlmAbort = null;

    // Drain in-flight partial flush; flushDb already .catch()es so this can't reject.
    if (inflightFlush) {
      await inflightFlush;
      inflightFlush = null;
    }

    if (isAbort(err)) {
      if (ctx.masterAbort.signal.aborted) {
        return { kind: "aborted", reason: "stopped" };
      }
      return { kind: "aborted", reason: "interjected" };
    }
    throw err;
  }

  if (pendingDbFlush) clearTimeout(pendingDbFlush);
  ctx.masterAbort.signal.removeEventListener("abort", onMasterAbort);
  ctx.currentLlmAbort = null;

  // Drain the most recent in-flight partial flush BEFORE the final write.
  // Synchronous backends already settled this; an async backend would
  // otherwise risk a stale partial landing AFTER the final and clobbering
  // it. See `inflightFlush` declaration for full rationale.
  if (inflightFlush) {
    await inflightFlush;
    inflightFlush = null;
  }

  // ── 6. Final flush — DB authoritative + assistant_complete emit ──────────
  const finalMetadata: Record<string, unknown> = {};
  if (result.thinking) finalMetadata["thinking"] = result.thinking;
  if (result.toolCalls.length > 0) finalMetadata["toolCalls"] = result.toolCalls;
  finalMetadata["usage"] = result.usage;

  await sc.update({
    entryId,
    taskId: ctx.taskId,
    content: result.content,
    metadata: finalMetadata,
    mergeMetadata: true,
    final: true,
  });

  // ── 7. Commit to LLM context ─────────────────────────────────────────────
  sc.commitToContext({
    entryId,
    kind: EntryKind.AiMessage,
    role: "assistant",
    content: result.content,
    ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    ...(result.thinking ? { thinking: result.thinking } : {}),
  });

  // ── 8. Token bookkeeping ─────────────────────────────────────────────────
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
