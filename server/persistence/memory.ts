/**
 * server/persistence/memory.ts
 *
 * In-memory implementations of `InfraPersistence` and `SessionPersistence`.
 *
 * For:
 *   - `huko run --memory` (one-shot, no disk side effects)
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
  ConfigRow,
  CreateChatSessionInput,
  CreateModelInput,
  CreateProviderInput,
  CreateTaskInput,
  EntryRow,
  InfraPersistence,
  ModelRow,
  ModelRowJoined,
  ProviderRow,
  ResolvedModelConfig,
  SessionPersistence,
  TaskRow,
  UpdateProviderPatch,
  UpdateTaskPatch,
} from "./types.js";

// ─── MemoryInfraPersistence ──────────────────────────────────────────────────

export class MemoryInfraPersistence implements InfraPersistence {
  private nextId = 1;
  private readonly _providers = new Map<number, ProviderRow>();
  private readonly _models = new Map<number, ModelRow>();
  private readonly _config = new Map<string, ConfigRow>();

  readonly providers: InfraPersistence["providers"];
  readonly models: InfraPersistence["models"];
  readonly config: InfraPersistence["config"];

  constructor() {
    const allocId = (): number => this.nextId++;
    const now = (): number => Date.now();

    this.providers = {
      list: async () => [...this._providers.values()],
      create: async (input: CreateProviderInput) => {
        const id = allocId();
        this._providers.set(id, {
          id,
          name: input.name,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          apiKeyRef: input.apiKeyRef,
          defaultHeaders: input.defaultHeaders ?? null,
          createdAt: now(),
        });
        return id;
      },
      update: async (id, patch: UpdateProviderPatch) => {
        const existing = this._providers.get(id);
        if (!existing) return;
        const next: ProviderRow = { ...existing };
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.protocol !== undefined) next.protocol = patch.protocol;
        if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
        if (patch.apiKeyRef !== undefined) next.apiKeyRef = patch.apiKeyRef;
        if (patch.defaultHeaders !== undefined) next.defaultHeaders = patch.defaultHeaders;
        this._providers.set(id, next);
      },
      delete: async (id) => {
        this._providers.delete(id);
        for (const [mid, m] of this._models) {
          if (m.providerId === id) this._models.delete(mid);
        }
      },
    };

    this.models = {
      list: async (): Promise<ModelRowJoined[]> => {
        const out: ModelRowJoined[] = [];
        for (const m of this._models.values()) {
          const p = this._providers.get(m.providerId);
          if (!p) continue;
          out.push({ ...m, providerName: p.name, providerProtocol: p.protocol });
        }
        return out;
      },
      create: async (input: CreateModelInput) => {
        const id = allocId();
        this._models.set(id, {
          id,
          providerId: input.providerId,
          modelId: input.modelId,
          displayName: input.displayName,
          defaultThinkLevel: input.defaultThinkLevel ?? "off",
          defaultToolCallMode: input.defaultToolCallMode ?? "native",
          createdAt: now(),
        });
        return id;
      },
      delete: async (id) => {
        this._models.delete(id);
      },
      resolveConfig: async (modelId): Promise<ResolvedModelConfig | null> => {
        const m = this._models.get(modelId);
        if (!m) return null;
        const p = this._providers.get(m.providerId);
        if (!p) return null;
        return {
          modelId: m.modelId,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKeyRef: p.apiKeyRef,
          toolCallMode: m.defaultToolCallMode,
          thinkLevel: m.defaultThinkLevel,
          defaultHeaders: p.defaultHeaders,
        };
      },
    };

    this.config = {
      get: async (key) => this._config.get(key)?.value ?? null,
      set: async (key, value) => {
        this._config.set(key, { key, value, updatedAt: now() });
      },
      list: async () => [...this._config.values()],
      getDefaultModelId: async () => {
        const v = this._config.get("default_model_id")?.value;
        return typeof v === "number" ? v : null;
      },
      setDefaultModelId: async (modelId) => {
        this._config.set("default_model_id", {
          key: "default_model_id",
          value: modelId,
          updatedAt: now(),
        });
      },
    };
  }

  close(): void {
    /* nothing to do */
  }
}

// ─── MemorySessionPersistence ────────────────────────────────────────────────

export class MemorySessionPersistence implements SessionPersistence {
  private nextId = 1;
  private readonly _sessions = new Map<number, ChatSessionRow>();
  private readonly _tasks = new Map<number, TaskRow>();
  private readonly _entries = new Map<number, EntryRow>();

  readonly entries: SessionPersistence["entries"];
  readonly sessions: SessionPersistence["sessions"];
  readonly tasks: SessionPersistence["tasks"];

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
