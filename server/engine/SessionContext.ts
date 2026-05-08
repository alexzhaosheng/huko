/**
 * server/engine/SessionContext.ts
 *
 * Session-scoped data bus. One instance per chat/agent session, shared
 * across all tasks that run within that session.
 *
 * Responsibilities:
 *   1. Own the in-memory LLM context array (the messages sent to the model)
 *   2. Persist new entries via the injected Persistence functions
 *   3. Emit `HukoEvent`s for all entry creation / finalization
 *   4. Support streaming updates (patch an existing entry's content/metadata)
 *
 * Event protocol: every emit goes through `this.emitter.emit(event)` —
 * which the gateway / CLI / test harness wraps to forward the typed
 * `HukoEvent` to wherever it needs to go (Socket.IO room, stdout, in-memory
 * collector, ...). See `shared/events.ts`.
 *
 * Streaming deltas (`assistant_content_delta` / `assistant_thinking_delta`)
 * are emitted by the pipeline DIRECTLY via `sessionContext.emit(...)`,
 * not via append/update — the delta is a chunk, not an entry mutation.
 *
 * Design rules:
 *   - `append()` is the ONLY way to add finalized entries. No back-doors.
 *   - `appendDraft()` opens a streaming entry; `update(...{final:true})` closes it.
 *   - The LLM context array is never written from outside this class.
 *   - SessionContext does not know about Socket.IO / DB / orchestrator.
 */

import type { LLMMessage } from "../core/llm/types.js";
import type { ToolCall, TokenUsage } from "../../shared/llm-protocol.js";
import type { EntryKind, SessionType, UserAttachment } from "../../shared/types.js";
import { isLLMVisible, EntryKind as EK } from "../../shared/types.js";
import type { HukoEvent } from "../../shared/events.js";

// ─── External Dependencies (injected, not imported directly) ──────────────────

/**
 * Minimal interface for persisting an entry to the database.
 * Injected at construction — SessionContext never imports db directly.
 */
export type PersistFn = (entry: {
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  kind: EntryKind;
  role: LLMMessage["role"];
  content: string;
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
}) => Promise<number>;

export type UpdateFn = (entryId: number, patch: {
  content?: string;
  metadata?: Record<string, unknown>;
  mergeMetadata?: boolean;
}) => Promise<void>;

/**
 * Outbound event channel. Implementations: Socket.IO room emit (daemon),
 * stdout JSON line (CLI), in-memory collector (tests).
 */
export type Emitter = {
  emit: (event: HukoEvent) => void;
};

// ─── Append / Update payloads ─────────────────────────────────────────────────

export type AppendPayload = {
  taskId: number;
  kind: EntryKind;
  role: LLMMessage["role"];
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdatePayload = {
  entryId: number;
  taskId: number;
  content?: string;
  metadata?: Record<string, unknown>;
  /** Shallow-merge `metadata` over existing instead of replacing. */
  mergeMetadata?: boolean;
  /**
   * True at the end of an assistant streaming turn — triggers an
   * `assistant_complete` HukoEvent emit. False / absent during streaming
   * partials (those are silent on the wire here; the pipeline already
   * sent `assistant_content_delta` events directly).
   */
  final?: boolean;
};

// ─── SessionContext ───────────────────────────────────────────────────────────

export class SessionContext {
  private readonly sessionId: number;
  private readonly sessionType: SessionType;

  private llmContext: LLMMessage[] = [];

  private readonly persist: PersistFn;
  private readonly updateDb: UpdateFn;
  private readonly emitter: Emitter;

  constructor(opts: {
    sessionId: number;
    sessionType: SessionType;
    persist: PersistFn;
    updateDb: UpdateFn;
    emitter: Emitter;
    initialContext?: LLMMessage[];
  }) {
    this.sessionId = opts.sessionId;
    this.sessionType = opts.sessionType;
    this.persist = opts.persist;
    this.updateDb = opts.updateDb;
    this.emitter = opts.emitter;
    this.llmContext = opts.initialContext ? [...opts.initialContext] : [];
  }

  // ─── Public Read API ───────────────────────────────────────────────────────

  get contextLength(): number {
    return this.llmContext.length;
  }

  /** Snapshot copy of the LLM context for the next model call. */
  getMessages(): LLMMessage[] {
    return [...this.llmContext];
  }

  // ─── emit() — shared HukoEvent emit point ──────────────────────────────────

  /**
   * Emit a `HukoEvent` to the configured emitter. Used by the pipeline
   * to send streaming deltas; also called internally by append/update.
   *
   * This is the single chokepoint for all kernel-emitted events — any
   * event going to a frontend goes through here.
   */
  emit(event: HukoEvent): void {
    this.emitter.emit(event);
  }

  // ─── append() — finalized entry write ──────────────────────────────────────

  async append(payload: AppendPayload): Promise<number> {
    const entryId = await this.persistEntry(payload);
    const event = this.entryToEvent(entryId, payload, /*started=*/ false);
    if (event) this.emit(event);
    if (isLLMVisible(payload.kind)) {
      this.llmContext.push(toMessage(payload, entryId));
    }
    return entryId;
  }

  // ─── appendDraft() — streaming entry start ─────────────────────────────────

  async appendDraft(payload: AppendPayload): Promise<number> {
    const entryId = await this.persistEntry(payload);
    const event = this.entryToEvent(entryId, payload, /*started=*/ true);
    if (event) this.emit(event);
    return entryId;
  }

  // ─── commitToContext() — push streamed entry into LLM context ──────────────

  /**
   * Push a draft entry into the LLM context with its final content.
   * Pairs with `appendDraft()` + final `update(...)`. Pure in-memory —
   * no DB write, no event emit (the assistant_complete event already fired
   * during the final update).
   */
  commitToContext(payload: {
    entryId: number;
    kind: EntryKind;
    role: LLMMessage["role"];
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string | null;
    thinking?: string | null;
  }): void {
    if (!isLLMVisible(payload.kind)) return;
    this.llmContext.push(toMessage(payload, payload.entryId));
  }

  // ─── update() — patch existing entry ───────────────────────────────────────

  async update(payload: UpdatePayload): Promise<void> {
    const { entryId, taskId, content, metadata, mergeMetadata, final } = payload;

    // 1. DB write
    await this.updateDb(entryId, {
      ...(content !== undefined ? { content } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(mergeMetadata !== undefined ? { mergeMetadata } : {}),
    });

    // 2. Emit assistant_complete on final flush; otherwise stay silent.
    //    (Streaming partials are emitted directly by the pipeline via
    //    `emit({ type: "assistant_content_delta", ... })`.)
    if (final) {
      const meta = (metadata ?? {}) as Record<string, unknown>;
      const thinking = meta["thinking"];
      const toolCalls = meta["toolCalls"];
      const usage = meta["usage"];
      this.emit({
        type: "assistant_complete",
        entryId,
        taskId,
        sessionId: this.sessionId,
        sessionType: this.sessionType,
        ts: Date.now(),
        content: content ?? "",
        ...(typeof thinking === "string" && thinking.length > 0 ? { thinking } : {}),
        ...(Array.isArray(toolCalls) && toolCalls.length > 0
          ? { toolCalls: toolCalls as ToolCall[] }
          : {}),
        usage: isTokenUsage(usage) ? usage : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    }
  }

  // ─── LLM Context Management ────────────────────────────────────────────────

  purgeMessages(entryIds: number[]): number {
    const idSet = new Set(entryIds);
    const before = this.llmContext.length;
    this.llmContext = this.llmContext.filter(m => !idSet.has(m._entryId ?? -1));
    return before - this.llmContext.length;
  }

  replaceContext(messages: LLMMessage[]): void {
    this.llmContext = [...messages];
  }

  removeFromTail(predicate: (msg: LLMMessage) => boolean): number {
    let removed = 0;
    while (this.llmContext.length > 0) {
      const last = this.llmContext[this.llmContext.length - 1]!;
      if (!predicate(last)) break;
      this.llmContext.pop();
      removed++;
    }
    return removed;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async persistEntry(payload: AppendPayload): Promise<number> {
    const { taskId, kind, role, content, toolCalls, toolCallId, thinking, metadata } = payload;

    const metadataWithCalls: Record<string, unknown> | null =
      toolCalls && toolCalls.length > 0
        ? { ...(metadata ?? {}), toolCalls }
        : (metadata ?? null);

    return this.persist({
      taskId,
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      kind,
      role,
      content,
      toolCallId: toolCallId ?? null,
      thinking: thinking ?? null,
      metadata: stripVolatileFields(metadataWithCalls),
    });
  }

  /** AppendPayload → HukoEvent translation. Returns null for kinds with no event. */
  private entryToEvent(
    entryId: number,
    payload: AppendPayload,
    started: boolean,
  ): HukoEvent | null {
    const base = {
      entryId,
      taskId: payload.taskId,
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      ts: Date.now(),
    };

    switch (payload.kind) {
      case EK.UserMessage: {
        const attachments = payload.metadata?.["attachments"] as UserAttachment[] | undefined;
        return {
          type: "user_message",
          ...base,
          content: payload.content,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
      }

      case EK.AiMessage:
        // Only `appendDraft` emits assistant_started; finalisation is
        // emitted by `update({final: true})`. A bare `append()` of an
        // AiMessage is unsupported in our model — return null.
        return started ? { type: "assistant_started", ...base } : null;

      case EK.ToolResult: {
        const meta = (payload.metadata ?? {}) as Record<string, unknown>;
        const toolName = typeof meta["toolName"] === "string" ? (meta["toolName"] as string) : "unknown";
        const error = typeof meta["error"] === "string" ? (meta["error"] as string) : null;
        // Strip top-level fields out of the surfaced metadata to avoid
        // duplication; UI consumers can see toolName/error/callId directly.
        const { toolName: _t, error: _e, arguments: _a, ...rest } = meta;
        const extraMeta = Object.keys(rest).length > 0 ? rest : undefined;
        return {
          type: "tool_result",
          ...base,
          callId: payload.toolCallId ?? "",
          toolName,
          content: payload.content,
          error,
          ...(extraMeta ? { metadata: extraMeta } : {}),
        };
      }

      case EK.SystemReminder:
        return {
          type: "system_reminder",
          ...base,
          content: payload.content,
        };

      case EK.StatusNotice: {
        const meta = (payload.metadata ?? {}) as Record<string, unknown>;
        const severity = meta["severity"];
        return {
          type: "system_notice",
          ...base,
          severity:
            severity === "warning" || severity === "error" ? severity : "info",
          content: payload.content,
        };
      }

      default:
        return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toMessage(
  opts: {
    role: LLMMessage["role"];
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string | null;
    thinking?: string | null;
  },
  entryId: number,
): LLMMessage {
  return {
    role: opts.role,
    content: opts.content,
    ...(opts.toolCalls && opts.toolCalls.length > 0 ? { toolCalls: opts.toolCalls } : {}),
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    _entryId: entryId,
  };
}

function stripVolatileFields(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return metadata ?? null;
  const attachments = metadata["attachments"];
  if (!Array.isArray(attachments)) return metadata;
  const hasVolatile = attachments.some(
    (a) => a && typeof a === "object" && "imageDataUrl" in (a as object),
  );
  if (!hasVolatile) return metadata;
  return {
    ...metadata,
    attachments: attachments.map((a) => {
      if (!a || typeof a !== "object") return a;
      const { imageDataUrl: _, ...rest } = a as Record<string, unknown>;
      return rest;
    }),
  };
}

function isTokenUsage(v: unknown): v is TokenUsage {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["promptTokens"] === "number" &&
    typeof o["completionTokens"] === "number" &&
    typeof o["totalTokens"] === "number"
  );
}
