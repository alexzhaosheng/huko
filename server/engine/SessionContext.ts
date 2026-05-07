/**
 * server/engine/SessionContext.ts
 *
 * Session-scoped data bus. One instance per chat/agent session, shared across
 * all tasks that run within that session.
 *
 * Responsibilities:
 *   1. Own the in-memory LLM context array (the messages sent to the model)
 *   2. Dispatch every new entry to three consumers simultaneously:
 *        a. DB persistence  — durable record
 *        b. WebSocket push  — real-time UI update
 *        c. LLM context     — in-memory array for next LLM call
 *   3. Support streaming updates (patch an existing entry's content/metadata)
 *   4. Expose read helpers used by the pipeline (contextLength, purge, etc.)
 *
 * Design rules:
 *   - `append()` is the ONLY way to add entries. No caller bypasses it.
 *   - `update()` is the ONLY way to patch entries. Same discipline.
 *   - The LLM context array is never written to directly from outside.
 *   - SessionContext does not know about task logic — it is a pure data bus.
 */

import type { LLMMessage, ToolCall } from "../core/llm/types.js";
import type { EntryKind, SessionType, TaskEntryPayload, TaskEntryUpdatePayload } from "../../shared/types.js";
import { isLLMVisible } from "../../shared/types.js";

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
}) => Promise<number>; // returns the new entry's DB id

/**
 * Minimal interface for patching an existing DB entry.
 */
export type UpdateFn = (entryId: number, patch: {
  content?: string;
  metadata?: Record<string, unknown>;
  mergeMetadata?: boolean;
}) => Promise<void>;

/**
 * Minimal interface for pushing events over WebSocket.
 * Keeps SessionContext decoupled from Socket.IO specifics.
 */
export type Emitter = {
  emit: (event: string, data: unknown) => void;
};

// ─── Append Payload ───────────────────────────────────────────────────────────

/**
 * Everything a caller provides when adding a new context entry.
 * `taskId` is required — entries always belong to a task.
 */
export type AppendPayload = {
  taskId: number;
  kind: EntryKind;
  role: LLMMessage["role"];
  content: string;
  /**
   * Tool calls produced by an assistant turn (native mode). Stored in
   * `metadata.toolCalls` for DB durability, and surfaced as a structured
   * field on the resulting `LLMMessage` so the next LLM call serializes
   * them through the protocol's native `tool_calls` array.
   */
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
};

// ─── Update Payload ───────────────────────────────────────────────────────────

export type UpdatePayload = {
  /** DB id of the entry to patch. */
  entryId: number;
  taskId: number;
  content?: string;
  metadata?: Record<string, unknown>;
  /**
   * When true, `metadata` is shallow-merged into the existing metadata
   * rather than replacing it.
   */
  mergeMetadata?: boolean;
};

// ─── SessionContext ───────────────────────────────────────────────────────────

export class SessionContext {
  private readonly sessionId: number;
  private readonly sessionType: SessionType;

  /** In-memory LLM context — the messages array sent to the model. */
  private llmContext: LLMMessage[] = [];

  /** Injected dependencies. */
  private readonly persist: PersistFn;
  private readonly updateDb: UpdateFn;
  private readonly emitter: Emitter;

  /** Routing info attached to every WebSocket event. */
  private readonly chatSessionId?: number;
  private readonly agentSessionId?: number;

  constructor(opts: {
    sessionId: number;
    sessionType: SessionType;
    persist: PersistFn;
    updateDb: UpdateFn;
    emitter: Emitter;
    /** Initial LLM context, e.g. loaded from DB when resuming a session. */
    initialContext?: LLMMessage[];
  }) {
    this.sessionId = opts.sessionId;
    this.sessionType = opts.sessionType;
    this.persist = opts.persist;
    this.updateDb = opts.updateDb;
    this.emitter = opts.emitter;
    this.llmContext = opts.initialContext ? [...opts.initialContext] : [];

    if (opts.sessionType === "chat") {
      this.chatSessionId = opts.sessionId;
    } else {
      this.agentSessionId = opts.sessionId;
    }
  }

  // ─── Public Read API ───────────────────────────────────────────────────────

  /** Number of messages currently in the LLM context. */
  get contextLength(): number {
    return this.llmContext.length;
  }

  /**
   * A snapshot of the LLM context for the next model call.
   * Returns a shallow copy — callers must not mutate the array.
   */
  getMessages(): LLMMessage[] {
    return [...this.llmContext];
  }

  // ─── append() — the single write entry point ───────────────────────────────

  /**
   * Add a new finalized entry to the session.
   *
   * Fires three side effects in order:
   *   1. Persist to DB (async) — establishes the canonical entry id
   *   2. Push to WebSocket (sync) — uses the id from step 1
   *   3. Append to LLM context (sync) — only if `isLLMVisible(kind)`
   *
   * Returns the DB id of the new entry.
   *
   * Use this for entries whose final content is known up front (user
   * messages, tool results, status notices). For streaming assistant
   * turns, see `appendDraft()` + `commitToContext()`.
   */
  async append(payload: AppendPayload): Promise<number> {
    const entryId = await this.persistAndEmit(payload);

    if (isLLMVisible(payload.kind)) {
      this.llmContext.push(toMessage(payload, entryId));
    }
    return entryId;
  }

  // ─── appendDraft() / commitToContext() — streaming assistant turns ─────────

  /**
   * Persist + emit a new entry but DO NOT push it to the LLM context yet.
   *
   * Used to start a streaming assistant turn: the empty entry is created
   * up front so we have an `entryId` to target with `update()` calls as
   * tokens arrive, but the message stays out of the LLM context until
   * the final content is known and `commitToContext()` is called.
   *
   * Rationale: pushing an empty `content: ""` message to the LLM context
   * would be wrong — if any code path peeked at context before the
   * stream finished, it would see a hollow turn.
   */
  async appendDraft(payload: AppendPayload): Promise<number> {
    return this.persistAndEmit(payload);
  }

  /**
   * Push a draft entry into the LLM context with its final content.
   *
   * Pairs with `appendDraft()`. Does NOT touch the DB or WebSocket —
   * those should already be in their final state via prior `update()`
   * calls. This method is purely about the in-memory context array.
   *
   * No-op if `kind` is not LLM-visible.
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

  // ─── Internal: shared DB + WS dispatch ─────────────────────────────────────

  private async persistAndEmit(payload: AppendPayload): Promise<number> {
    const { taskId, kind, role, content, toolCalls, toolCallId, thinking, metadata } = payload;

    // Tool calls travel as part of metadata for DB durability. The LLM
    // context gets them as a structured field via `toMessage()`.
    const metadataWithCalls: Record<string, unknown> | null =
      toolCalls && toolCalls.length > 0
        ? { ...(metadata ?? {}), toolCalls }
        : (metadata ?? null);

    const entryId = await this.persist({
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

    const wsPayload: TaskEntryPayload = {
      id: entryId,
      taskId,
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      kind,
      role,
      content,
      toolCallId: toolCallId ?? null,
      thinking: thinking ?? null,
      // UI gets the unstripped metadata so it can render attachments
      // (with imageDataUrl) inline on the first turn.
      metadata: metadataWithCalls ?? null,
      createdAt: new Date(),
      ...(this.chatSessionId !== undefined ? { chatSessionId: this.chatSessionId } : {}),
      ...(this.agentSessionId !== undefined ? { agentSessionId: this.agentSessionId } : {}),
    };
    this.emitter.emit("task:entry", wsPayload);

    return entryId;
  }

  // ─── update() — patch an existing entry ───────────────────────────────────

  /**
   * Patch an existing entry's content and/or metadata.
   * Used for streaming text updates and post-hoc metadata tagging.
   *
   * Fires two side effects:
   *   1. Update DB row
   *   2. Push `task:entry_update` to WebSocket
   *
   * Does NOT update the in-memory LLM context — the context array holds
   * the original content and is append-only by design.
   */
  async update(payload: UpdatePayload): Promise<void> {
    const { entryId, taskId, content, metadata, mergeMetadata } = payload;

    // ── 1. Update DB ────────────────────────────────────────────────────────
    await this.updateDb(entryId, {
      ...(content !== undefined ? { content } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(mergeMetadata !== undefined ? { mergeMetadata } : {}),
    });

    // ── 2. WebSocket push ───────────────────────────────────────────────────
    const wsPayload: TaskEntryUpdatePayload = {
      id: entryId,
      taskId,
      ...(content !== undefined ? { content } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    this.emitter.emit("task:entry_update", wsPayload);
  }

  // ─── LLM Context Management ────────────────────────────────────────────────

  /**
   * Remove entries from the LLM context by their DB ids.
   * Used by the compaction pipeline to evict old messages.
   * Returns the number of messages actually removed.
   */
  purgeMessages(entryIds: number[]): number {
    const idSet = new Set(entryIds);
    const before = this.llmContext.length;
    this.llmContext = this.llmContext.filter(m => !idSet.has(m._entryId ?? -1));
    return before - this.llmContext.length;
  }

  /**
   * Replace the entire LLM context.
   * Used after a compaction pass that rewrites history (e.g. summary injection).
   */
  replaceContext(messages: LLMMessage[]): void {
    this.llmContext = [...messages];
  }

  /**
   * Remove messages from the tail of the LLM context that match a predicate.
   * Stops at the first message that does NOT match.
   * Used to strip corrective messages before a retry.
   */
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an LLMMessage from an entry payload + entryId.
 * Thin projection — no logic about what's LLM-visible (that's `isLLMVisible`).
 */
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

/**
 * Remove fields that must not be persisted to the DB long-term.
 * Currently strips `imageDataUrl` from attachment metadata to avoid
 * ballooning the DB with base64 data.
 */
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
