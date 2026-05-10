/**
 * server/persistence/types.ts
 *
 * `SessionPersistence` — per-project conversation state at
 * `<cwd>/.huko/huko.db`: chat_sessions, tasks, the LLM-visible entry
 * log. Drop a project, drop its `.huko/`, and the conversations go
 * with it.
 *
 * Provider/model/system-default config used to live in a sibling
 * `InfraPersistence` (SQLite). It moved to layered JSON files —
 * see `server/config/infra-config.ts`. The interface is gone; the
 * row shapes too.
 *
 * Plaintext API keys are NEVER stored here. See `server/security/keys.ts`.
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
 * SessionContext construction time.
 */

import type { LLMMessage } from "../core/llm/types.js";
import type { ThinkLevel, ToolCallMode } from "../core/llm/types.js";
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
