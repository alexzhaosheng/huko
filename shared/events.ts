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
 * Heartbeat fired during long, silent LLM calls — the wait between
 * "request sent" and "first token received" can be 30s+ on thinking
 * models. Without these ticks, callers piping huko's output (especially
 * `huko` invoked from another huko's bash tool) see no activity for
 * minutes and may treat the process as hung.
 *
 * Cadence: emitted every ~10s by `task/pipeline/llm-call.ts` while no
 * stream chunk has arrived in the same window. Stops as soon as the
 * first content/thinking delta lands. The text formatter renders it
 * as a single dim "·" on stderr; jsonl passes it through; the json
 * (final-only) formatter ignores it.
 */
export type LLMProgressTickEvent = {
  type: "llm_progress_tick";
  entryId: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  /** Milliseconds since the LLM call began. */
  elapsedMs: number;
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

// ─── Ask-user (interactive question from the AI) ─────────────────────────────

/**
 * The AI invoked `message(type=ask, ...)` — it wants information from
 * the user before continuing. Frontends render the question (and any
 * predefined options) and call `orchestrator.respondToAsk(toolCallId, reply)`
 * with the answer. The Promise the orchestrator is awaiting resolves;
 * the answer becomes the tool_result that the LLM sees on the next turn.
 *
 * `toolCallId` is the unique id from the LLM's tool call — stable across
 * the Promise's lifetime, used as the registry key on the orchestrator
 * side so multiple concurrent asks (future daemon mode) don't collide.
 *
 * `selectionType`:
 *   - `single`   — pick exactly one of `options`  (radio in a UI)
 *   - `multiple` — pick zero or more of `options` (checkboxes)
 *   - omitted    — free-form text reply
 */
export type AskUserEvent = {
  type: "ask_user";
  taskId: number;
  /** Stable id of the tool call that triggered this ask. */
  toolCallId: string;
  question: string;
  options?: string[];
  selectionType?: "single" | "multiple";
  ts: number;
};

/**
 * The shape every frontend submits back to `orchestrator.respondToAsk`.
 * `content` is the human-readable reply that becomes the tool_result.
 * For multi-choice asks, frontends synthesise `content` themselves
 * (e.g. join selected options with ", ") — keeping the reply
 * representation uniform regardless of selectionType.
 */
export type AskUserReply = {
  content: string;
  /** Optional structured selection, when the user picked from `options`. */
  selected?: string[];
};

/**
 * Emitted when the safety-policy gate has decided to PROMPT the operator
 * before running a tool call. The frontend (CLI / daemon / IDE) renders
 * the request and resolves via `orchestrator.respondToDecision`.
 *
 * Distinct from `ask_user`:
 *   - `ask_user`         : LLM initiated, free-text reply expected.
 *   - `decision_required`: tool-pipeline initiated, ternary reply
 *                          ("allow" | "deny" | "allow_and_remember").
 *
 * The reply shape lets the operator pick:
 *   - `allow`              — execute this one call; rules unchanged
 *   - `deny`               — refuse this one call; LLM gets `user_denied`
 *   - `allow_and_remember` — execute, AND persist matchedPattern to
 *                            the global `safety.toolRules.<tool>.allow`
 *                            list so future calls auto-execute
 */
export type DecisionRequiredEvent = {
  type: "decision_required";
  taskId: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  matchedPattern?: string;
  matchedField?: string;
  matchedValue?: string;
  ts: number;
};

export type DecisionReply = {
  kind: "allow" | "deny" | "allow_and_remember";
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
  /** Subset of `promptTokens` billed as prompt-cache READS. Optional. */
  cachedTokens?: number;
  /** Tokens written into the prompt cache (Anthropic). Optional. */
  cacheCreationTokens?: number;
  elapsedMs: number;
};

// ─── The union ───────────────────────────────────────────────────────────────

export type HukoEvent =
  | UserMessageEvent
  | AssistantStartedEvent
  | AssistantContentDeltaEvent
  | AssistantThinkingDeltaEvent
  | AssistantCompleteEvent
  | LLMProgressTickEvent
  | ToolResultEvent
  | SystemNoticeEvent
  | SystemReminderEvent
  | TaskTerminatedEvent
  | TaskErrorEvent
  | OrphanRecoveredEvent
  | AskUserEvent
  | DecisionRequiredEvent;

// ─── Wire constants ──────────────────────────────────────────────────────────

/** The single Socket.IO event name that carries every HukoEvent. */
export const HUKO_WIRE_EVENT = "huko";
