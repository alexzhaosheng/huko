/**
 * shared/llm-protocol.ts
 *
 * Protocol-level types — the wire-facing surface of the LLM layer.
 *
 * These types live in `shared/` (not `server/`) because they appear in
 * `HukoEvent` payloads (e.g. `ToolCall` inside `assistant_complete`) and
 * therefore cross the kernel/frontend boundary.
 *
 * Server-internal LLM types (LLMMessage, LLMTurnResult, LLMCallOptions,
 * PartialEvent, StreamCallback) stay in `server/core/llm/types.ts` —
 * they are tied to the engine's runtime and never travel to a frontend.
 *
 * `server/core/llm/types.ts` re-exports the types in this file for
 * backward-compatible imports.
 */

// ─── Wire identifiers ─────────────────────────────────────────────────────────

/** Wire protocol used to talk to the model provider. */
export type Protocol = "openai" | "anthropic";

/** How tool invocations are signalled in the request/response. */
export type ToolCallMode = "xml" | "native";

/** Reasoning depth hint passed through to providers that support it. */
export type ThinkLevel = "off" | "low" | "medium" | "high";

/** Conversation roles. */
export type Role = "system" | "user" | "assistant" | "tool";

// ─── Token usage ──────────────────────────────────────────────────────────────

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

// ─── Tool definitions ─────────────────────────────────────────────────────────

export type ToolParameterSchema = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
};

export type Tool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
};

/** A tool invocation produced by the assistant (or parsed from XML). */
export type ToolCall = {
  /** Stable identifier — matches up with `tool_result.callId`. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
