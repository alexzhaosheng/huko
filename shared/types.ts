/**
 * shared/types.ts
 *
 * Cross-runtime types shared between kernel and frontends.
 * No runtime dependencies — pure type definitions and const enums.
 */

// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionType = "chat" | "agent";

export type SessionOwnership =
  | { sessionType: "chat";  chatSessionId: number; agentSessionId?: never }
  | { sessionType: "agent"; agentSessionId: number; chatSessionId?: never };

// ─── Entry Kind ───────────────────────────────────────────────────────────────

export const EntryKind = {
  UserMessage:   "user_message",
  AiMessage:     "ai_message",
  ToolCall:      "tool_call",
  ToolResult:    "tool_result",
  SystemPrompt:  "system_prompt",
  SystemReminder:"system_reminder",
  StatusNotice:  "status_notice",
} as const;

export type EntryKind = typeof EntryKind[keyof typeof EntryKind];

/**
 * Returns true if this kind should be included in the in-memory LLM
 * context array. Two kinds are persisted-but-not-context:
 *   - status_notice — operational logging, never shown to the LLM
 *   - system_prompt — passed separately by the LLM-call pipeline as
 *     the `system` field; if we ALSO pushed it into llmContext, the
 *     model would see it twice. Persisted so debug tooling can show
 *     what was actually sent.
 */
export function isLLMVisible(kind: EntryKind): boolean {
  return kind !== EntryKind.StatusNotice && kind !== EntryKind.SystemPrompt;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export type UserAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  path: string;
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
