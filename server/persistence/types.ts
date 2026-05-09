/**
 * server/persistence/types.ts
 *
 * Two persistence interfaces, two scopes:
 *
 *   InfraPersistence    user-global  (~/.huko/infra.db)
 *     providers / models / app_config (system-level defaults like
 *     default_model_id). Lives once per machine; carries the user's
 *     "personal toolbox" of LLM providers and models.
 *
 *   SessionPersistence  per-project  (<cwd>/.huko/huko.db)
 *     entries / chat_sessions / tasks. Each project directory gets its
 *     own conversation log. Drop a project, drop its `.huko/` and the
 *     conversations go with it.
 *
 * The two were one combined `Persistence` interface in the v0.1 layout,
 * which conflated user identity (API endpoints / keys) with project
 * conversation state. That conflation forced the DB to live next to
 * source code, made provider configs per-project (re-config every clone),
 * and risked plaintext API keys ending up in commits.
 *
 * Splitting also lets the orchestrator be honest about which persistence
 * a given operation hits: token bookkeeping → session, model resolution
 * → infra, etc.
 *
 * **Plaintext keys never live in any DB.** `providers.apiKeyRef` is a
 * logical name (e.g. "openrouter"); the actual secret is resolved at
 * runtime by `server/security/keys.ts` from env / .huko/keys.json / .env.
 *
 * Backends:
 *   - SqliteInfraPersistence   / SqliteSessionPersistence   (default)
 *   - MemoryInfraPersistence   / MemorySessionPersistence   (--memory, tests)
 *
 * SessionContext keeps its existing `PersistFn` / `UpdateFn` function-shape
 * dependency. Orchestrator destructures them out of `session.entries` at
 * SessionContext construction time. SessionContext stays decoupled from
 * the SessionPersistence interface as a whole — unit tests can stub two
 * bare functions.
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
  /**
   * Logical key reference (e.g. "openrouter"). NOT the actual key.
   * Pass through `resolveApiKey(ref, { cwd })` to get the secret.
   */
  apiKeyRef: string;
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

/**
 * Result of `infra.models.resolveConfig(modelId)` — the connection
 * shape the orchestrator needs to make an LLM call.
 *
 * `apiKeyRef` is what the persistence layer carries (never the secret
 * itself). The orchestrator calls `resolveApiKey(apiKeyRef, { cwd })`
 * before constructing TaskContext to turn the ref into a usable key.
 * Doing it that late means provider definitions stay scoped to infra
 * while the credential lookup honours per-cwd `.huko/keys.json` /
 * `.env` overrides.
 */
export type ResolvedModelConfig = {
  modelId: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyRef: string;
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
  apiKeyRef: string;
  defaultHeaders?: Record<string, string> | null;
};

export type UpdateProviderPatch = {
  name?: string;
  protocol?: Protocol;
  baseUrl?: string;
  apiKeyRef?: string;
  defaultHeaders?: Record<string, string> | null;
};

export type CreateModelInput = {
  providerId: number;
  modelId: string;
  displayName: string;
  defaultThinkLevel?: ThinkLevel;
  defaultToolCallMode?: ToolCallMode;
};

// ─── SessionPersistence — per-project DB ─────────────────────────────────────

export interface SessionPersistence {
  readonly entries: {
    persist: PersistFn;
    update: UpdateFn;
    /**
     * Replay the LLM-visible history of a session into LLMMessages.
     * Used by resume / "continue conversation" flows.
     *
     * Already filters out entries elided by previous compactions (see
     * `metadata.elidedEntryIds` on `compaction_done` reminders).
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
     */
    listNonTerminal(): Promise<TaskRow[]>;
  };

  /**
   * Graceful shutdown — close connections, flush WAL, etc.
   * Required: every backend implements this even if it's a no-op.
   */
  close(): Promise<void> | void;
}

// ─── InfraPersistence — user-global DB ───────────────────────────────────────

export interface InfraPersistence {
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
    /**
     * Convenience accessor for the system-level default model id (a
     * numeric models.id stored under app_config["default_model_id"]).
     * Project-level "default model" is a separate concept that lives
     * in `<cwd>/.huko/config.json`'s `model.default` (logical name).
     */
    getDefaultModelId(): Promise<number | null>;
    setDefaultModelId(modelId: number): Promise<void>;
  };

  /** Graceful shutdown — see `SessionPersistence.close`. */
  close(): Promise<void> | void;
}
