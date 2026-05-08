/**
 * shared/types.ts
 *
 * Cross-runtime types shared between kernel and frontends.
 * No runtime dependencies — pure type definitions and const enums.
 *
 * Sibling files:
 *   - `llm-protocol.ts` — wire-level LLM types (Tool, ToolCall, TokenUsage, ...)
 *   - `events.ts`       — `HukoEvent` discriminated union
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
 *   - Everything except `status_notice` goes to the LLM.
 *   - Everything goes to the UI (each kind rendered differently).
 */
export const EntryKind = {
  // ── Core conversation (LLM + UI) ──
  UserMessage:   "user_message",
  AiMessage:     "ai_message",
  ToolCall:      "tool_call",
  ToolResult:    "tool_result",
  SystemPrompt:  "system_prompt",
  SystemReminder:"system_reminder",
  // ── Operational (UI only, never sent to LLM) ──
  StatusNotice:  "status_notice",
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
