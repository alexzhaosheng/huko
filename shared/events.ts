/**
 * shared/events.ts
 *
 * `HukoEvent` — the kernel → frontend event protocol.
 *
 * This is THE wire format for everything the kernel wants to tell a
 * consumer (CLI text formatter, CLI JSON output, future external web UI,
 * IDE plugin). All events flow through this single typed channel.
 *
 * Wire transport: Socket.IO emits one event name `"huko"` carrying a
 * `HukoEvent` payload. Consumers attach one listener and switch on
 * `event.type` (TS narrows perfectly because of the discriminated union).
 *
 * Three sources emit HukoEvents:
 *   1. SessionContext  — entry-level events (user_message, assistant_started,
 *                        assistant_complete, tool_result, system_*)
 *   2. Pipeline        — streaming deltas (assistant_content_delta,
 *                        assistant_thinking_delta) emitted directly via
 *                        `sessionContext.emit()`
 *   3. Orchestrator    — task lifecycle (task_terminated, task_error)
 *                        emitted via the cached session emitter.
 *   4. Bootstrap       — orphan recovery (orphan_recovered), one per
 *                        healed orphan task at startup.
 *
 * Adding a new event type:
 *   1. Add a sub-type below.
 *   2. Add it to the `HukoEvent` union.
 *   3. Add the producing call site (kernel side).
 *   4. Add the case to each frontend's switch.
 */

import type { TaskStatus, SessionType, UserAttachment } from "./types.js";
import type { ToolCall, TokenUsage } from "./llm-protocol.js";

// ─── Common base for entry-bound events ──────────────────────────────────────

/**
 * Fields shared by every event that's bound to a specific persisted entry.
 *
 * `sessionId` + `sessionType` are denormalised onto every event (even
 * deltas) so consumers can route to a session without maintaining an
 * `entryId → session` cache. The few extra bytes are well worth the
 * frontend simplicity.
 */
type EntryEventBase = {
  entryId: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  /** Server epoch ms when the event was generated. */
  ts: number;
};

// ─── Conversation events ─────────────────────────────────────────────────────

/** A user message landed (typed in by the user). */
export type UserMessageEvent = EntryEventBase & {
  type: "user_message";
  content: string;
  attachments?: UserAttachment[];
};

/** An assistant turn started — render a placeholder bubble. */
export type AssistantStartedEvent = EntryEventBase & {
  type: "assistant_started";
};

/** A chunk of assistant text arrived (streaming). Concatenate across deltas. */
export type AssistantContentDeltaEvent = {
  type: "assistant_content_delta";
  entryId: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  delta: string;
};

/** A chunk of assistant reasoning arrived (streaming). */
export type AssistantThinkingDeltaEvent = {
  type: "assistant_thinking_delta";
  entryId: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  delta: string;
};

/**
 * The assistant turn finalised. `content` is authoritative — whatever the
 * frontend reconstructed via deltas should match. `toolCalls`, when
 * present, will each receive a follow-up `tool_result` event.
 */
export type AssistantCompleteEvent = EntryEventBase & {
  type: "assistant_complete";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
};

/** A tool result came back. `callId` matches a prior `assistant_complete.toolCalls[].id`. */
export type ToolResultEvent = EntryEventBase & {
  type: "tool_result";
  callId: string;
  toolName: string;
  /** Result text, or empty string on error. */
  content: string;
  /** Non-null on error; null on success. */
  error: string | null;
  /** Tool-specific extras (e.g. `screenshot` for workstation tools). */
  metadata?: Record<string, unknown>;
};

/** A status notice (compaction, failure banner, etc). */
export type SystemNoticeEvent = EntryEventBase & {
  type: "system_notice";
  severity: "info" | "warning" | "error";
  content: string;
};

/** A mid-conversation system reminder injected by the kernel. */
export type SystemReminderEvent = EntryEventBase & {
  type: "system_reminder";
  content: string;
};

// ─── Task lifecycle events (per-task, no entry binding) ──────────────────────

/** A task reached a terminal state cleanly. */
export type TaskTerminatedEvent = {
  type: "task_terminated";
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  status: Extract<TaskStatus, "done" | "failed" | "stopped">;
  summary: TaskSummary;
};

/** A task crashed with an unhandled exception. */
export type TaskErrorEvent = {
  type: "task_error";
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  error: string;
};

/**
 * Orphan-recovery healed a task left over from a previous crash.
 *
 * Emitted at startup, once per orphan task that the resume pass found
 * and "stitched" — the task is now `failed`; if it had assistant
 * `tool_use`s without matching `tool_result`s, synthetic results have
 * been written to keep provider-side pairing valid.
 *
 * Frontends should render this prominently (yellow, etc.) so users
 * notice the previous crash. It's not an error — the data is healed —
 * but it's a non-trivial state change worth flagging.
 */
export type OrphanRecoveredEvent = {
  type: "orphan_recovered";
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  ts: number;
  /** Short reason: e.g. "process exited mid-tool" / "process exited while waiting for user reply". */
  reason: string;
  /** How many synthetic tool_result rows were injected to repair pairing. 0 if none needed. */
  danglingToolCount: number;
};

// ─── Summary type (for task_terminated) ──────────────────────────────────────

/**
 * Wire-facing task summary. Distinct from `TaskRunSummary` (the
 * orchestrator's internal type) — equal in shape today, but kept
 * independent so internal evolution doesn't break the protocol.
 */
export type TaskSummary = {
  finalResult: string;
  hasExplicitResult: boolean;
  toolCallCount: number;
  iterationCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  elapsedMs: number;
};

// ─── The union ───────────────────────────────────────────────────────────────

export type HukoEvent =
  | UserMessageEvent
  | AssistantStartedEvent
  | AssistantContentDeltaEvent
  | AssistantThinkingDeltaEvent
  | AssistantCompleteEvent
  | ToolResultEvent
  | SystemNoticeEvent
  | SystemReminderEvent
  | TaskTerminatedEvent
  | TaskErrorEvent
  | OrphanRecoveredEvent;

// ─── Wire constants ──────────────────────────────────────────────────────────

/** The single Socket.IO event name that carries every HukoEvent. */
export const HUKO_WIRE_EVENT = "huko";
