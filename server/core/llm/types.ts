/**
 * server/core/llm/types.ts
 *
 * LLM layer types.
 *
 * Wire-level types (Protocol, ToolCallMode, ThinkLevel, Role, ToolCall,
 * Tool, TokenUsage, ToolParameterSchema) live in `shared/llm-protocol.ts`
 * and are re-exported here for backward-compatible imports.
 *
 * Server-internal types (LLMMessage with `_entryId`, LLMTurnResult,
 * LLMCallOptions, PartialEvent, StreamCallback) live here — they're
 * tied to the engine's runtime and never travel to a frontend.
 */

// ─── Re-exports from shared/llm-protocol.ts ──────────────────────────────────

export type {
  Protocol,
  ToolCallMode,
  ThinkLevel,
  Role,
  TokenUsage,
  ToolParameterSchema,
  Tool,
  ToolCall,
} from "../../../shared/llm-protocol.js";

import type { Role, Tool, ToolCall, TokenUsage } from "../../../shared/llm-protocol.js";
import type { EntryKind } from "../../../shared/types.js";

// ─── Server-internal types ───────────────────────────────────────────────────

/**
 * A single message in the LLM context window.
 *
 * `_entryId` and `_entryKind` are back-references to the DB row — used
 * by compaction (which messages to evict, how to summarise them) and
 * orphan recovery. Both are stripped before the message is sent to the
 * LLM provider.
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
  /**
   * Internal: the persisted entry kind. Lets compaction distinguish a
   * real user_message (a new goal from the user) from a system_reminder
   * (which carries role:"user" too in our schema). Without this, both
   * look identical at the LLMMessage layer and the elision digest
   * can't truthfully describe what was dropped.
   */
  _entryKind?: EntryKind;
};

/**
 * Normalised output of one LLM turn. Protocol differences are fully
 * resolved by the adapter and `invoke()` before this type is produced.
 */
export type LLMTurnResult = {
  content: string;
  toolCalls: ToolCall[];
  thinking?: string;
  usage: TokenUsage;
};

/**
 * Streamed partial event. Emitted via `LLMCallOptions.onPartial` while
 * the response is still arriving. Tool-call streaming is intentionally
 * NOT exposed.
 */
export type PartialEvent =
  | { type: "content"; delta: string }
  | { type: "thinking"; delta: string };

export type StreamCallback = (event: PartialEvent) => void;

/** Everything needed to make a single LLM call. */
export type LLMCallOptions = {
  protocol: import("../../../shared/llm-protocol.js").Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  messages: LLMMessage[];
  tools: Tool[];
  toolCallMode: import("../../../shared/llm-protocol.js").ToolCallMode;
  thinkLevel?: import("../../../shared/llm-protocol.js").ThinkLevel;
  signal?: AbortSignal;
  onPartial?: StreamCallback;
  /** Additional headers (e.g. OpenRouter `HTTP-Referer` / `X-Title`). */
  headers?: Record<string, string>;
  /** Provider-specific request-body extras forwarded verbatim. */
  extras?: Record<string, unknown>;
};
