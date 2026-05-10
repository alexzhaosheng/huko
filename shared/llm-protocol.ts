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
  /**
   * Subset of `promptTokens` that came from prompt-cache reads. Only
   * surfaced when the provider reports it: OpenAI exposes this as
   * `usage.prompt_tokens_details.cached_tokens`; Anthropic (via its
   * native API) reports it as `cache_read_input_tokens`. Omitted when
   * the provider doesn't break down the prompt.
   */
  cachedTokens?: number;
  /**
   * Tokens written into the prompt cache during this call (Anthropic
   * specific — `cache_creation_input_tokens`). 0 / omitted when the
   * provider doesn't have a write-side concept (e.g. OpenAI's
   * automatic prefix cache is read-only from a billing perspective).
   */
  cacheCreationTokens?: number;
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
