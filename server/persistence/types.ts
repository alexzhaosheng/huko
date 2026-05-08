/**
 * server/persistence/types.ts
 *
 * The Persistence interface — the single seam between huko's kernel and
 * any storage backend (in-memory, SQLite, Postgres, log services, ...).
 *
 * Backed by:
 *   - MemoryPersistence  — full impl, in-memory, lost on exit
 *   - SqlitePersistence  — full impl backed by better-sqlite3 + Drizzle
 *   - external packages  — `huko-persistence-postgres` etc.
 *
 * Two tiers:
 *   Tier 1 — kernel-required: a TaskLoop can run with just these. Engine
 *            calls `entries.persist` / `entries.update` from SessionContext
 *            and `entries.loadLLMContext` on session resume.
 *   Tier 2 — daemon-required: list sessions, manage providers/models, etc.
 *            Needed by tRPC routers and the orchestrator's session lookup.
 *
 * SessionContext keeps its existing `PersistFn` / `UpdateFn` function-shape
 * dependency. The orchestrator destructures them out of `persistence.entries`
 * at SessionContext construction time. This lets SessionContext stay
 * decoupled from the Persistence interface as a whole — unit tests can
 * stub two bare functions.
 */

import type { LLMMessage } from "../core/llm/types.js";
import type { Protocol, ThinkLevel, ToolCallMode } from "../core/llm/types.js";
import type { SessionType, TaskStatus } from "../../shared/types.js";
import type { PersistFn, UpdateFn } from "../engine/SessionContext.js";

// ─── Row shapes (what queries return) ────────────────────────────────────────

export type ChatSessionRow = {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type TaskRow = {
  id: number;
  chatSessionId: number | null;
  agentSessionId: number | null;
  status: TaskStatus;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCallCount: number;
  iterationCount: number;
  finalResult: string;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EntryRow = {
  id: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  kind: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId: string | null;
  thinking: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
};

export type ProviderRow = {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  defaultHeaders: Record<string, string> | null;
  createdAt: number;
};

export type ModelRow = {
  id: number;
  providerId: number;
  modelId: string;
  displayName: string;
  defaultThinkLevel: ThinkLevel;
  defaultToolCallMode: ToolCallMode;
  createdAt: number;
};

export type ModelRowJoined = ModelRow & {
  providerName: string;
  providerProtocol: Protocol;
};

export type ResolvedModelConfig = {
  modelId: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  defaultHeaders: Record<string, string> | null;
  /**
   * Model context window in tokens. Optional in storage (we don't
   * have a `models.context_window` column yet); orchestrator fills it
   * via `estimateContextWindow(modelId)` when the persistence-side
   * value is absent. Compaction uses this to scale its thresholds —
   * see `pipeline/context-manage.ts`.
   */
  contextWindow?: number;
};

export type ConfigRow = {
  key: string;
  value: unknown;
  updatedAt: number;
};

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type CreateChatSessionInput = {
  title?: string;
};

export type CreateTaskInput = {
  chatSessionId: number | null;
  agentSessionId: number | null;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  status?: TaskStatus;
};

export type UpdateTaskPatch = {
  status?: TaskStatus;
  finalResult?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCallCount?: number;
  iterationCount?: number;
  errorMessage?: string;
};

export type CreateProviderInput = {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  defaultHeaders?: Record<string, string> | null;
};

export type UpdateProviderPatch = {
  name?: string;
  protocol?: Protocol;
  baseUrl?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string> | null;
};

export type CreateModelInput = {
  providerId: number;
  modelId: string;
  displayName: string;
  defaultThinkLevel?: ThinkLevel;
  defaultToolCallMode?: ToolCallMode;
};

// ─── The interface ───────────────────────────────────────────────────────────

export interface Persistence {
  readonly entries: {
    persist: PersistFn;
    update: UpdateFn;
    /**
     * Replay the LLM-visible history of a session into LLMMessages.
     * Used by resume / "continue conversation" flows.
     *
     * TODO(continue-conversation): when resume / `huko run --session=N`
     * lands, this method must filter out entries whose ids appear in
     * any `<system_reminder reason="compaction_done">`'s
     * `metadata.elidedEntryIds`. Otherwise the loaded context contains
     * BOTH the elision marker AND the elided entries — self-contradictory
     * and re-blows the context window. The compactor records those IDs
     * on the write side already (see `pipeline/context-manage.ts`); only
     * the read-side filter is missing.
     */
    loadLLMContext(sessionId: number, type: SessionType): Promise<LLMMessage[]>;
    listForSession(sessionId: number, type: SessionType): Promise<EntryRow[]>;
  };

  readonly sessions: {
    create(input: CreateChatSessionInput): Promise<number>;
    list(): Promise<ChatSessionRow[]>;
    get(id: number): Promise<ChatSessionRow | null>;
    delete(id: number): Promise<void>;
  };

  readonly tasks: {
    create(input: CreateTaskInput): Promise<number>;
    update(id: number, patch: UpdateTaskPatch): Promise<void>;
    get(id: number): Promise<TaskRow | null>;
    /**
     * List every task whose status is NOT terminal (i.e. not `done` /
     * `failed` / `stopped`). Used by resume / orphan recovery at startup.
     * Implementations return [] when there are none.
     */
    listNonTerminal(): Promise<TaskRow[]>;
  };

  readonly providers: {
    list(): Promise<ProviderRow[]>;
    create(input: CreateProviderInput): Promise<number>;
    update(id: number, patch: UpdateProviderPatch): Promise<void>;
    delete(id: number): Promise<void>;
  };

  readonly models: {
    list(): Promise<ModelRowJoined[]>;
    create(input: CreateModelInput): Promise<number>;
    delete(id: number): Promise<void>;
    resolveConfig(modelId: number): Promise<ResolvedModelConfig | null>;
  };

  readonly config: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    list(): Promise<ConfigRow[]>;
    getDefaultModelId(): Promise<number | null>;
    setDefaultModelId(modelId: number): Promise<void>;
  };

  /**
   * Graceful shutdown — close connections, flush WAL, etc.
   * Required: every backend implements this even if it's a no-op
   * (MemoryPersistence). Making it part of the interface lets callers
   * do `persistence.close()` without duck-typing.
   */
  close(): Promise<void> | void;
}

// ─── Errors (none currently — backends throw standard Error if needed) ──────
