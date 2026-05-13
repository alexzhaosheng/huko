/**
 * server/persistence/memory.ts
 *
 * In-memory implementation of `SessionPersistence`. The infra-config
 * sibling went away when providers/models moved to JSON files (see
 * server/config/infra-config.ts).
 *
 * For:
 *   - `huko --memory` (one-shot, no disk side effects)
 *   - Unit tests — hand-rolled fixtures, fast teardown
 *   - Sandboxes / read-only filesystems
 *
 * Each class implements ONE interface. Tests / ephemeral runs that need
 * both create both. The two share an internal id counter through
 * dependency injection only when they need linked ids — otherwise each
 * keeps its own.
 */

import { isLLMVisible } from "../../shared/types.js";
import type { LLMMessage, ToolCall } from "../core/llm/types.js";
import type { EntryKind, SessionType } from "../../shared/types.js";
import type {
  ChatSessionRow,
  CreateChatSessionInput,
  CreateTaskInput,
  CreateTaskWithInitialEntryInput,
  EntryRow,
  SessionPersistence,
  SubstitutionRecord,
  SubstitutionRow,
  TaskRow,
  UpdateTaskPatch,
} from "./types.js";

// ─── MemorySessionPersistence ────────────────────────────────────────────────

export class MemorySessionPersistence implements SessionPersistence {
  private nextId = 1;
  private readonly _sessions = new Map<number, ChatSessionRow>();
  private readonly _tasks = new Map<number, TaskRow>();
  private readonly _entries = new Map<number, EntryRow>();

  readonly entries: SessionPersistence["entries"];
  readonly sessions: SessionPersistence["sessions"];
  readonly tasks: SessionPersistence["tasks"];
  readonly substitutions: SessionPersistence["substitutions"];

  // (sessionId|sessionType) → (placeholder → row)
  private readonly _subs = new Map<string, Map<string, SubstitutionRow>>();

  constructor() {
    const allocId = (): number => this.nextId++;
    const now = (): number => Date.now();

    this.entries = {
      persist: async (entry) => {
        const id = allocId();
        const row: EntryRow = {
          id,
          taskId: entry.taskId,
          sessionId: entry.sessionId,
          sessionType: entry.sessionType,
          kind: entry.kind,
          role: entry.role,
          content: entry.content,
          toolCallId: entry.toolCallId ?? null,
          thinking: entry.thinking ?? null,
          metadata: entry.metadata ?? null,
          createdAt: now(),
        };
        this._entries.set(id, row);
        return id;
      },
      update: async (entryId, patch) => {
        const existing = this._entries.get(entryId);
        if (!existing) return;
        const next: EntryRow = { ...existing };
        if (patch.content !== undefined) next.content = patch.content;
        if (patch.metadata !== undefined) {
          if (patch.mergeMetadata) {
            next.metadata = { ...(existing.metadata ?? {}), ...patch.metadata };
          } else {
            next.metadata = patch.metadata;
          }
        }
        this._entries.set(entryId, next);
      },
      loadLLMContext: async (sessionId, type) => {
        const rows = this.entriesForSession(sessionId, type);
        const dropped = collectElidedEntryIds(rows);
        const out: LLMMessage[] = [];
        for (const r of rows) {
          if (dropped.has(r.id)) continue;
          const m = projectToLLMMessage(r);
          if (m) out.push(m);
        }
        return out;
      },
      listForSession: async (sessionId, type) => {
        return this.entriesForSession(sessionId, type);
      },
    };

    this.sessions = {
      create: async (input: CreateChatSessionInput) => {
        const id = allocId();
        const t = now();
        this._sessions.set(id, {
          id,
          title: input.title ?? "",
          createdAt: t,
          updatedAt: t,
        });
        return id;
      },
      list: async () => {
        return [...this._sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      },
      get: async (id) => this._sessions.get(id) ?? null,
      delete: async (id) => {
        this._sessions.delete(id);
        const droppedTaskIds = new Set<number>();
        for (const [tid, t] of this._tasks) {
          if (t.chatSessionId === id || t.agentSessionId === id) {
            this._tasks.delete(tid);
            droppedTaskIds.add(tid);
          }
        }
        for (const [eid, e] of this._entries) {
          if (droppedTaskIds.has(e.taskId)) this._entries.delete(eid);
        }
      },
    };

    this.tasks = {
      create: async (input: CreateTaskInput) => {
        const id = allocId();
        const t = now();
        this._tasks.set(id, {
          id,
          chatSessionId: input.chatSessionId,
          agentSessionId: input.agentSessionId,
          status: input.status ?? "running",
          modelId: input.modelId,
          toolCallMode: input.toolCallMode,
          thinkLevel: input.thinkLevel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          toolCallCount: 0,
          iterationCount: 0,
          finalResult: "",
          errorMessage: null,
          createdAt: t,
          updatedAt: t,
        });
        return id;
      },
      createWithInitialEntry: async (input: CreateTaskWithInitialEntryInput) => {
        // Single-threaded JS: between these two synchronous map sets
        // nothing else can run, so this is naturally atomic. No `await`
        // between the two lines.
        const taskId = allocId();
        const t = now();
        this._tasks.set(taskId, {
          id: taskId,
          chatSessionId: input.task.chatSessionId,
          agentSessionId: input.task.agentSessionId,
          status: input.task.status ?? "running",
          modelId: input.task.modelId,
          toolCallMode: input.task.toolCallMode,
          thinkLevel: input.task.thinkLevel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          toolCallCount: 0,
          iterationCount: 0,
          finalResult: "",
          errorMessage: null,
          createdAt: t,
          updatedAt: t,
        });
        const entryId = allocId();
        this._entries.set(entryId, {
          id: entryId,
          taskId,
          sessionId: input.entry.sessionId,
          sessionType: input.entry.sessionType,
          kind: input.entry.kind,
          role: input.entry.role,
          content: input.entry.content,
          toolCallId: input.entry.toolCallId ?? null,
          thinking: input.entry.thinking ?? null,
          metadata: input.entry.metadata ?? null,
          createdAt: now(),
        });
        return { taskId, entryId };
      },
      update: async (id, patch: UpdateTaskPatch) => {
        const existing = this._tasks.get(id);
        if (!existing) return;
        const next: TaskRow = { ...existing, updatedAt: now() };
        if (patch.status !== undefined) next.status = patch.status;
        if (patch.finalResult !== undefined) next.finalResult = patch.finalResult;
        if (patch.promptTokens !== undefined) next.promptTokens = patch.promptTokens;
        if (patch.completionTokens !== undefined) next.completionTokens = patch.completionTokens;
        if (patch.totalTokens !== undefined) next.totalTokens = patch.totalTokens;
        if (patch.toolCallCount !== undefined) next.toolCallCount = patch.toolCallCount;
        if (patch.iterationCount !== undefined) next.iterationCount = patch.iterationCount;
        if (patch.errorMessage !== undefined) next.errorMessage = patch.errorMessage;
        this._tasks.set(id, next);
      },
      get: async (id) => this._tasks.get(id) ?? null,
      listNonTerminal: async () => {
        const out: TaskRow[] = [];
        for (const t of this._tasks.values()) {
          if (t.status !== "done" && t.status !== "failed" && t.status !== "stopped") {
            out.push(t);
          }
        }
        return out;
      },
    };

    const subKey = (sid: number, type: SessionType): string => `${sid}|${type}`;
    const subBucket = (sid: number, type: SessionType) => {
      const k = subKey(sid, type);
      let b = this._subs.get(k);
      if (b === undefined) {
        b = new Map();
        this._subs.set(k, b);
      }
      return b;
    };
    this.substitutions = {
      record: async (input: SubstitutionRecord): Promise<void> => {
        const bucket = subBucket(input.sessionId, input.sessionType);
        if (bucket.has(input.placeholder)) return; // ignore — strict idempotence
        bucket.set(input.placeholder, {
          ...input,
          createdAt: now(),
        });
      },
      lookupByPlaceholder: async (sid, type, placeholder): Promise<string | null> => {
        return this._subs.get(subKey(sid, type))?.get(placeholder)?.rawValue ?? null;
      },
      lookupByRaw: async (sid, type, rawValue): Promise<string | null> => {
        const bucket = this._subs.get(subKey(sid, type));
        if (!bucket) return null;
        for (const row of bucket.values()) {
          if (row.rawValue === rawValue) return row.placeholder;
        }
        return null;
      },
      listForSession: async (sid, type): Promise<SubstitutionRow[]> => {
        return [...(this._subs.get(subKey(sid, type))?.values() ?? [])];
      },
    };
  }

  private entriesForSession(sessionId: number, type: SessionType): EntryRow[] {
    const out: EntryRow[] = [];
    for (const r of this._entries.values()) {
      if (r.sessionId === sessionId && r.sessionType === type) out.push(r);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  close(): void {
    /* nothing to do */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectToLLMMessage(r: EntryRow): LLMMessage | null {
  if (!isLLMVisible(r.kind as EntryKind)) return null;
  const meta = r.metadata as Record<string, unknown> | null;
  const toolCalls = meta?.["toolCalls"] as ToolCall[] | undefined;
  return {
    role: r.role,
    content: r.content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
    ...(r.thinking ? { thinking: r.thinking } : {}),
    _entryId: r.id,
    _entryKind: r.kind as EntryKind,
  };
}

/**
 * Walk all SystemReminder entries with reason=compaction_done, gather
 * their `metadata.elidedEntryIds` arrays. Returns the union — IDs to
 * drop on context replay.
 *
 * Used by Memory and Sqlite session backends in their loadLLMContext
 * path. Lifted into shared util so both backends reach the same conclusion.
 */
export function collectElidedEntryIds(rows: EntryRow[]): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.kind !== "system_reminder") continue;
    const meta = r.metadata as Record<string, unknown> | null;
    if (!meta || meta["reminderReason"] !== "compaction_done") continue;
    const ids = meta["elidedEntryIds"];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "number") out.add(id);
      }
    }
  }
  return out;
}
