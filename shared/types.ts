/**
 * shared/types.ts
 *
 * Types shared between server and client.
 * No runtime dependencies — pure type definitions and const enums.
 */

// ─── Session ──────────────────────────────────────────────────────────────────

/** A session belongs to either a chat thread or a background agent. */
export type SessionType = "chat" | "agent";

/** Identifies which session owns a task. Exactly one branch is populated. */
export type SessionOwnership =
  | { sessionType: "chat";  chatSessionId: number; agentSessionId?: never }
  | { sessionType: "agent"; agentSessionId: number; chatSessionId?: never };

// ─── Entry Kind ───────────────────────────────────────────────────────────────

/**
 * What kind of entry is this in the conversation log.
 *
 * Two orthogonal concerns collapsed into one field for simplicity:
 *   - Semantic meaning (what is it?)
 *   - Routing (does it go to LLM? to UI?)
 *
 * Rule of thumb:
 *   - Everything except `status_notice` goes to the LLM.
 *   - Everything goes to the UI (but rendered differently per kind).
 */
export const EntryKind = {
  // ── Core conversation (LLM + UI) ──
  UserMessage:   "user_message",   // user sent a message
  AiMessage:     "ai_message",     // AI text reply (message tool or final turn)
  ToolCall:      "tool_call",      // AI requested a tool execution
  ToolResult:    "tool_result",    // result of a tool execution
  SystemPrompt:  "system_prompt",  // system prompt (first message)
  SystemReminder:"system_reminder",// mid-conversation system injection (LLM + UI)

  // ── Operational (UI only, never sent to LLM) ──
  StatusNotice:  "status_notice",  // compaction notice, stopped, error banner, etc.
} as const;

export type EntryKind = typeof EntryKind[keyof typeof EntryKind];

/** Returns true if this kind should be included in the LLM context. */
export function isLLMVisible(kind: EntryKind): boolean {
  return kind !== EntryKind.StatusNotice;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

/** A file attached by the user to a message. */
export type UserAttachment = {
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Server-relative path: /uploads/<hash>.<ext> */
  path: string;
  /**
   * Base64 data URL — populated only on the first turn when the file is uploaded.
   * Never persisted to DB. Stripped before storage.
   */
  imageDataUrl?: string;
};

// ─── Task Status ──────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_reply"
  | "waiting_for_approval"
  | "done"
  | "failed"
  | "stopped";

/** Terminal states — a task in one of these will not resume. */
export const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "stopped"]);

// ─── WebSocket Event Payloads ─────────────────────────────────────────────────

/**
 * Payload emitted as `task:entry` when a new context entry is created.
 * The client appends this to the session's message list.
 */
export type TaskEntryPayload = {
  id: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  kind: EntryKind;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  // Routing helpers for the client
  chatSessionId?: number;
  agentSessionId?: number;
};

/**
 * Payload emitted as `task:entry_update` for streaming or metadata patches.
 */
export type TaskEntryUpdatePayload = {
  id: number;
  taskId: number;
  content?: string;
  metadata?: Record<string, unknown>;
};

/** Emitted as `task:done` when the task loop exits cleanly. */
export type TaskDonePayload = {
  taskId: number;
  toolCallCount: number;
  totalTokens: number;
};

/** Emitted as `task:error` when the task loop throws. */
export type TaskErrorPayload = {
  taskId: number;
  error: string;
};
