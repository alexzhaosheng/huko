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
 * Design rules:
 *   - `append()` is the ONLY way to add finalized entries. No back-doors.
 *   - `appendDraft()` opens a streaming entry; `update(...{final:true})` closes it.
 *   - `appendReminder()` is the single seam for `<system_reminder>` injection.
 *   - The LLM context array is never written from outside this class.
 *   - SessionContext does not know about Socket.IO / DB / orchestrator.
 */

import type { LLMMessage } from "../core/llm/types.js";
import type { ToolCall, TokenUsage } from "../../shared/llm-protocol.js";
import type { EntryKind, SessionType, UserAttachment } from "../../shared/types.js";
import { isLLMVisible, EntryKind as EK } from "../../shared/types.js";
import type { HukoEvent } from "../../shared/events.js";

// ─── External Dependencies (injected, not imported directly) ──────────────────

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
  mergeMetadata?: boolean;
  /** True at the end of an assistant streaming turn — triggers `assistant_complete`. */
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

  getMessages(): LLMMessage[] {
    return [...this.llmContext];
  }

  // ─── emit() ────────────────────────────────────────────────────────────────

  /**
   * @internal — direct event emit, used by the pipeline for streaming
   * deltas. External code should use `append` / `appendDraft` /
   * `update` / `appendReminder`, which auto-emit the right event.
   */
  emit(event: HukoEvent): void {
    this.emitter.emit(event);
  }

  // ─── append() ──────────────────────────────────────────────────────────────

  /**
   * Persist (or accept already-persisted) an entry, emit the matching
   * HukoEvent, and update the in-memory llmContext if the kind is
   * LLM-visible.
   *
   * `opts.knownEntryId` lets the caller skip the persist step when the
   * row was inserted out-of-band — currently only by
   * `SessionPersistence.tasks.createWithInitialEntry`, which writes
   * the task row + the initial entry in a single SQLite transaction
   * (so we'd double-write if we let `append()` persist too). The seam
   * stays single — every entry that enters the in-memory context still
   * goes through this method — but the persist call is opt-out for
   * atomic-create paths.
   */
  async append(
    payload: AppendPayload,
    opts?: { knownEntryId?: number },
  ): Promise<number> {
    const entryId =
      opts?.knownEntryId !== undefined
        ? opts.knownEntryId
        : await this.persistEntry(payload);
    const event = this.entryToEvent(entryId, payload, /*started=*/ false);
    if (event) this.emit(event);
    if (isLLMVisible(payload.kind)) {
      this.llmContext.push(toMessage(payload, entryId));
    }
    return entryId;
  }

  // ─── appendDraft() ─────────────────────────────────────────────────────────

  async appendDraft(payload: AppendPayload): Promise<number> {
    const entryId = await this.persistEntry(payload);
    const event = this.entryToEvent(entryId, payload, /*started=*/ true);
    if (event) this.emit(event);
    return entryId;
  }

  // ─── commitToContext() ─────────────────────────────────────────────────────

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

  // ─── appendReminder() — single seam for system_reminder injection ─────────

  /**
   * Inject a system reminder into the conversation. THIS IS THE ONLY
   * supported way to surface a reminder to the LLM — never inline
   * reminder text into a tool_result content field, never write a
   * `<system_reminder>` tag manually anywhere else.
   *
   * Why a dedicated method instead of `append({kind: SystemReminder})`:
   *   1. Wraps content in `<system_reminder reason="...">...</system_reminder>`
   *      consistently — the LLM gets a uniform tag shape.
   *   2. Enforces `role: "user"` — Anthropic / OpenAI both accept reminders
   *      as if a user said them; assistant-side or tool-side reminders
   *      confuse the model.
   *   3. Persists the `reason` (machine identifier) in metadata so we can
   *      query "did we already nudge this task about empty turns?" without
   *      string-matching content.
   *   4. Future compaction can spot reminder rows by kind and decide
   *      whether to keep or drop them.
   *
   * `reason` is a short stable identifier (`empty_turn` / `compaction_done`
   * / `language_drift` / `water_level` / ...). Free-form prose goes in
   * `content`.
   */
  async appendReminder(opts: {
    taskId: number;
    reason: string;
    content: string;
    extraMetadata?: Record<string, unknown>;
  }): Promise<number> {
    const wrapped = `<system_reminder reason="${escapeAttr(opts.reason)}">${opts.content}</system_reminder>`;
    const metadata: Record<string, unknown> = {
      reminderReason: opts.reason,
      ...(opts.extraMetadata ?? {}),
    };
    return this.append({
      taskId: opts.taskId,
      kind: EK.SystemReminder,
      role: "user",
      content: wrapped,
      metadata,
    });
  }

  // ─── update() ──────────────────────────────────────────────────────────────

  async update(payload: UpdatePayload): Promise<void> {
    const { entryId, taskId, content, metadata, mergeMetadata, final } = payload;

    await this.updateDb(entryId, {
      ...(content !== undefined ? { content } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(mergeMetadata !== undefined ? { mergeMetadata } : {}),
    });

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
        return started ? { type: "assistant_started", ...base } : null;

      case EK.ToolResult: {
        const meta = (payload.metadata ?? {}) as Record<string, unknown>;
        const toolName = typeof meta["toolName"] === "string" ? (meta["toolName"] as string) : "unknown";
        const error = typeof meta["error"] === "string" ? (meta["error"] as string) : null;
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
    kind: EntryKind;
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
    _entryKind: opts.kind,
  };
}

function escapeAttr(s: string): string {
  // Strict: only allow [a-z0-9_-] in reason. Anything else collapses to "_"
  // so the tag shape is never broken by user-provided text.
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
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
