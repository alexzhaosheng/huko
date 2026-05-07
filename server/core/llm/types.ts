/**
 * server/core/llm/types.ts
 *
 * Core types for the LLM calling layer.
 * These flow through the entire engine: SessionContext owns the LLMMessage[],
 * TaskLoop reads it, pipeline modules produce and consume it.
 *
 * Kept minimal and protocol-agnostic. Concrete API shapes (Anthropic, OpenAI)
 * live in invoke.ts and are never exposed here.
 */

// ─── Messages ─────────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * A single message in the LLM context window.
 *
 * `_entryId` is a back-reference to the DB row — used by compaction to
 * identify which messages to evict. Never sent to the LLM provider.
 */
export type LLMMessage = {
  role: Role;
  content: string;
  /**
   * Tool calls produced by the assistant in this turn (native mode).
   * In XML mode, calls are embedded inside `content` instead and this
   * field stays undefined.
   */
  toolCalls?: ToolCall[];
  /** For tool results: the ID of the tool call this is responding to. */
  toolCallId?: string;
  /** For assistant turns with thinking: the reasoning content. */
  thinking?: string;
  /** Internal: DB entry ID for compaction tracking. */
  _entryId?: number;
};

// ─── Tools ────────────────────────────────────────────────────────────────────

/** JSON Schema for a single tool parameter. */
export type ToolParameterSchema = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
};

/** Tool definition sent to the LLM. */
export type Tool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
};

/** A tool call as parsed from the LLM response. */
export type ToolCall = {
  /** Unique ID for this invocation — needed to pair with the tool result. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

// ─── LLM Response ─────────────────────────────────────────────────────────────

/**
 * Normalised output of one LLM turn.
 *
 * Protocol differences (OpenAI vs Anthropic vs XML mode) are fully
 * resolved by the adapter and `invoke()` before this type is produced.
 * Callers downstream only ever see this shape.
 */
export type LLMTurnResult = {
  /**
   * Plain text content of the turn. In XML mode, `<function_calls>` blocks
   * are stripped out and surfaced via `toolCalls` instead.
   */
  content: string;
  /** Parsed tool calls. Empty array if the LLM produced no calls. */
  toolCalls: ToolCall[];
  /** Extended thinking / reasoning content, if the model supports it. */
  thinking?: string;
  /** Token usage for this turn. */
  usage: TokenUsage;
};

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Wire protocol used to talk to the model provider.
 *
 * Each value here corresponds to a registered adapter under
 * `server/core/llm/adapters/`. New protocols are added by writing an
 * adapter and registering it — no other file changes required.
 */
export type Protocol = "openai" | "anthropic";

/**
 * How the LLM signals tool invocations.
 *
 * - `xml`      — model wraps calls in <function_calls> XML inside text content
 * - `native`   — model uses the provider's native tool_use / function_call API
 */
export type ToolCallMode = "xml" | "native";

/**
 * Thinking depth — controls whether and how much the model reasons before
 * responding. `off` disables thinking entirely.
 */
export type ThinkLevel = "off" | "low" | "medium" | "high";

/** Token usage reported by the provider. */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Streamed partial event. Emitted via `LLMCallOptions.onPartial` while
 * the response is still arriving. Tool-call streaming is intentionally
 * NOT exposed — args are accumulated internally and surfaced as part of
 * the final `LLMTurnResult` to keep callers simple.
 */
export type PartialEvent =
  | { type: "content"; delta: string }
  | { type: "thinking"; delta: string };

export type StreamCallback = (event: PartialEvent) => void;

/** Everything needed to make a single LLM call. */
export type LLMCallOptions = {
  /** Wire protocol — selects the adapter. */
  protocol: Protocol;
  /** The model identifier as understood by the provider (e.g. "anthropic/claude-opus-4-5"). */
  model: string;
  /** Base URL of the provider API (no trailing slash required). */
  baseUrl: string;
  /** API key. */
  apiKey: string;
  /** Full conversation history. */
  messages: LLMMessage[];
  /** Tools available for this call. */
  tools: Tool[];
  /** How tools are invoked. */
  toolCallMode: ToolCallMode;
  /** Optional thinking configuration. */
  thinkLevel?: ThinkLevel;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * If provided, the call is made in streaming mode and partials are
   * pushed through this callback as they arrive. The Promise still
   * resolves to the final, fully-assembled `LLMTurnResult`.
   */
  onPartial?: StreamCallback;
  /**
   * Extra HTTP headers (e.g. OpenRouter's `HTTP-Referer` / `X-Title`).
   * Merged on top of the adapter's own headers.
   */
  headers?: Record<string, string>;
  /**
   * Provider-specific extras forwarded into the request body verbatim.
   * Use sparingly — this is the escape hatch for non-portable knobs.
   */
  extras?: Record<string, unknown>;
};
