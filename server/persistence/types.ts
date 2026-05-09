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
 * **Plaintext keys never live in any DB.** `providers.apiKeyRef` is a
 * logical name (e.g. "openrouter"); the actual secret is resolved at
 * runtime by `server/security/keys.ts` from env / .huko/keys.json / .env.
 *
 * Backends:
 *   - SqliteInfraPersistence   / SqliteSessionPersistence   (default)
 *   - MemoryInfraPersistence   / MemorySessionPersistence   (--memory, tests)
 *
 * Atomicity contract (see persistence.md):
 *   - Single-row writes are atomic (SQLite per-statement).
 *   - Task lifecycle's "create task + persist initial entry" is atomic
 *     via `tasks.createWithInitialEntry` (one transaction). The
 *     orchestrator uses this to avoid the "task row but no user
 *     message" ghost state under crash.
 *   - Multi-step lifecycle further out (assistant turn + tool_results)
 *     is NOT transactional; resume/orphan recovery is the answer.
 *
 * SessionContext keeps its existing `PersistFn` / `UpdateFn` function-shape
 * dependency. Orchestrator destructures them out of `session.entries` at
 * SessionContext construction time. SessionContext stays decoupled from
 * the SessionPersistence interface as a whole — unit tests can stub two
 * bare functions.
 */

import type { LLMMessage } from "../core/llm/types.js";
import type { Protocol, ThinkLevel, ToolCallMode } from "../core/llm/types.js";
import type { EntryKind, SessionType, TaskStatus } from "../../shared/types.js";
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
   * Model context window in tokens. Optional in storage; orchestrator
   * fills it via `estimateContextWindow(modelId)` when absent.
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

/**
 * The shape of an entry to persist atomically alongside a freshly
 * created task. Identical to `PersistFn`'s parameter except `taskId`
 * is omitted — the implementation fills it in after the task INSERT.
 */
export type InitialEntryInput = {
  sessionId: number;
  sessionType: SessionType;
  kind: EntryKind;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CreateTaskWithInitialEntryInput = {
  task: CreateTaskInput;
  entry: InitialEntryInput;
};

// ─── SessionPersistence — per-project DB ─────────────────────────────────────

export interface SessionPersistence {
  readonly entries: {
    persist: PersistFn;
    update: UpdateFn;
    /**
     * Replay the LLM-visible history of a session into LLMMessages.
     * Already filters out entries elided by previous compactions.
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
    /**
     * Atomic: create the task row AND persist its initial entry in
     * one transaction. Used at task spinup to avoid the "task created
     * but user message lost" ghost state if the process dies between
     * two separate inserts.
     *
     * Returns both the new task id and the new entry id. Callers
     * (orchestrator) then notify SessionContext via
     * `append(payload, { knownEntryId })` to emit the event and update
     * the in-memory llmContext WITHOUT a redundant DB write.
     */
    createWithInitialEntry(
      input: CreateTaskWithInitialEntryInput,
    ): Promise<{ taskId: number; entryId: number }>;
    update(id: number, patch: UpdateTaskPatch): Promise<void>;
    get(id: number): Promise<TaskRow | null>;
    /**
     * List every task whose status is NOT terminal (i.e. not `done` /
     * `failed` / `stopped`). Used by resume / orphan recovery at startup.
     */
    listNonTerminal(): Promise<TaskRow[]>;
  };

  /** Graceful shutdown — close connections, flush WAL, etc. */
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
     */
    getDefaultModelId(): Promise<number | null>;
    setDefaultModelId(modelId: number): Promise<void>;
  };

  /** Graceful shutdown — see `SessionPersistence.close`. */
  close(): Promise<void> | void;
}
