/**
 * server/task/pipeline/llm-call.ts
 *
 * The LLM call step of the task loop.
 *
 * What happens inside a single call:
 *   1. Build messages: system prompt + session LLM context + maybe a
 *      transient language-drift reminder.
 *   2. appendDraft an empty assistant entry -> assistant_started event.
 *   3. Wire dual abort signals (master + currentLlmAbort).
 *   4. Invoke the LLM with onPartial. Each delta emitted as a HukoEvent
 *      and the DB row throttled-synced.
 *   5. Drain any in-flight partial flush.
 *   6. Final write via update({final:true}) -> assistant_complete.
 *   7. commitToContext.
 *   8. Token bookkeeping.
 */

import { invoke } from "../../core/llm/invoke.js";
import type { LLMCallOptions, LLMTurnResult, PartialEvent } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";
import { EntryKind } from "../../../shared/types.js";
import { maybeBuildLanguageDriftReminder } from "../language-reminder.js";

// ─── Result type ──────────────────────────────────────────────────────────────

export type LLMCallOutcome =
  | { kind: "ok"; entryId: number; result: LLMTurnResult }
  | { kind: "aborted"; reason: "interjected" | "stopped" };

// ─── Streaming throttle ───────────────────────────────────────────────────────

const DB_FLUSH_MS = 100;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function callLLM(ctx: TaskContext): Promise<LLMCallOutcome> {
  const sc = ctx.sessionContext;

  // ── 1. Build messages ────────────────────────────────────────────────────
  // Includes a transient language-drift reminder when the recent context
  // tail is dominated by content in a different script than the task's
  // working language. The reminder is NOT persisted and NOT pushed onto
  // SessionContext.llmContext — each call recomputes whether to inject.
  const baseMessages = sc.getMessages();
  const driftReminder = maybeBuildLanguageDriftReminder(
    baseMessages,
    ctx.workingLanguage,
  );
  const messages = [
    { role: "system" as const, content: ctx.systemPrompt },
    ...baseMessages,
    ...(driftReminder ? [driftReminder] : []),
  ];

  // ── 2. Draft assistant entry ─────────────────────────────────────────────
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

  if (inflightFlush) {
    await inflightFlush;
    inflightFlush = null;
  }

  // ── 6. Final flush ──────────────────────────────────────────────────────
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
