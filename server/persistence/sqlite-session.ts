/**
 * server/persistence/sqlite-session.ts
 *
 * SQLite implementation of `SessionPersistence`. Per-project DB at
 * `<cwd>/.huko/huko.db` (override via `opts.dbPath` for tests).
 *
 * Owns:
 *   - chat_sessions
 *   - tasks
 *   - task_context (a.k.a. entries)
 *
 * Auto-creates the `<cwd>/.huko/` directory + a default `.gitignore`
 * (huko.db / keys.json / state.json / lock / *-journal/-wal/-shm) on
 * construction. Runs migrations from `server/db/migrations/session/`.
 */

import { eq, and, asc, desc } from "drizzle-orm";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database, {
  type Database as BetterSqlite3Database,
} from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "../db/migrate.js";
import * as schema from "../db/schema/session.js";
import {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
  type SessionDb,
} from "../db/adapter.js";
import { collectElidedEntryIds } from "./memory.js";
import type {
  ChatSessionRow,
  CreateChatSessionInput,
  CreateTaskInput,
  CreateTaskWithInitialEntryInput,
  EntryRow,
  SessionPersistence,
  TaskRow,
  UpdateTaskPatch,
} from "./types.js";
import type { LLMMessage } from "../core/llm/types.js";
import type { SessionType } from "../../shared/types.js";

const { chatSessions, tasks, taskContext } = schema;

export type SqliteSessionPersistenceOptions = {
  /** Working directory the project DB lives under. Defaults to process.cwd(). */
  cwd?: string;
  /** Override DB path entirely (tests). When set, .huko/.gitignore is NOT auto-created. */
  dbPath?: string;
};

export class SqliteSessionPersistence implements SessionPersistence {
  private readonly sqlite: BetterSqlite3Database;
  private readonly db: SessionDb;

  readonly entries: SessionPersistence["entries"];
  readonly sessions: SessionPersistence["sessions"];
  readonly tasks: SessionPersistence["tasks"];

  constructor(opts: SqliteSessionPersistenceOptions = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const dbPath = opts.dbPath ?? path.join(cwd, ".huko", "huko.db");
    const hukoDir = path.dirname(dbPath);
    mkdirSync(hukoDir, { recursive: true });

    // First-run scaffolding: drop a sensible .gitignore in `<cwd>/.huko/`
    // so the conversation DB and any future keys.json don't accidentally
    // get committed. Only when using the default path — explicit dbPath
    // (tests, custom layouts) gets nothing auto-generated.
    if (opts.dbPath === undefined) {
      ensureGitignore(hukoDir);
    }

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite, { schema });

    runMigrations(this.sqlite, migrationsDir());

    const db = this.db;

    // ── entries ────────────────────────────────────────────────────────────
    this.entries = {
      persist: makePersistEntry(db),
      update: makeUpdateEntry(db),
      loadLLMContext: async (sessionId: number, type: SessionType): Promise<LLMMessage[]> => {
        const messages = await loadSessionLLMContext(db, sessionId, type);
        // Drop entries elided by previous compactions. See
        // pipeline/context-manage.ts.
        const allRows = await db
          .select()
          .from(taskContext)
          .where(and(eq(taskContext.sessionId, sessionId), eq(taskContext.sessionType, type)))
          .orderBy(asc(taskContext.id))
          .all();
        const elided = collectElidedEntryIds(allRows.map(toEntryRow));
        if (elided.size === 0) return messages;
        return messages.filter((m) => m._entryId === undefined || !elided.has(m._entryId));
      },
      listForSession: async (sessionId, type): Promise<EntryRow[]> => {
        const rows = await db
          .select()
          .from(taskContext)
          .where(and(eq(taskContext.sessionId, sessionId), eq(taskContext.sessionType, type)))
          .orderBy(asc(taskContext.id))
          .all();
        return rows.map(toEntryRow);
      },
    };

    // ── sessions ────────────────────────────────────────────────────────────
    this.sessions = {
      create: async (input: CreateChatSessionInput): Promise<number> => {
        const row = await db
          .insert(chatSessions)
          .values({ title: input.title ?? "" })
          .returning({ id: chatSessions.id })
          .get();
        return row.id;
      },
      list: async (): Promise<ChatSessionRow[]> => {
        const rows = await db
          .select()
          .from(chatSessions)
          .orderBy(desc(chatSessions.updatedAt))
          .all();
        return rows.map(toChatSessionRow);
      },
      get: async (id: number): Promise<ChatSessionRow | null> => {
        const row = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
        return row ? toChatSessionRow(row) : null;
      },
      delete: async (id: number): Promise<void> => {
        await db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
      },
    };

    // ── tasks ──────────────────────────────────────────────────────────────
    this.tasks = {
      create: async (input: CreateTaskInput): Promise<number> => {
        const row = await db
          .insert(tasks)
          .values({
            chatSessionId: input.chatSessionId,
            agentSessionId: input.agentSessionId,
            status: input.status ?? "running",
            modelId: input.modelId,
            toolCallMode: input.toolCallMode,
            thinkLevel: input.thinkLevel,
          })
          .returning({ id: tasks.id })
          .get();
        return row.id;
      },
      createWithInitialEntry: async (
        input: CreateTaskWithInitialEntryInput,
      ): Promise<{ taskId: number; entryId: number }> => {
        // better-sqlite3's transaction API takes a sync callback —
        // we can't `await` inside it. That's fine: drizzle's better-sqlite3
        // adapter is also sync under the hood, so .returning(...).get()
        // resolves synchronously. We assert the shape with `unknown` to
        // keep the type system honest about the sync-vs-async boundary.
        const result = this.sqlite.transaction(() => {
          const taskRow = db
            .insert(tasks)
            .values({
              chatSessionId: input.task.chatSessionId,
              agentSessionId: input.task.agentSessionId,
              status: input.task.status ?? "running",
              modelId: input.task.modelId,
              toolCallMode: input.task.toolCallMode,
              thinkLevel: input.task.thinkLevel,
            })
            .returning({ id: tasks.id })
            .get() as unknown as { id: number };

          const entryRow = db
            .insert(taskContext)
            .values({
              taskId: taskRow.id,
              sessionId: input.entry.sessionId,
              sessionType: input.entry.sessionType,
              kind: input.entry.kind,
              role: input.entry.role,
              content: input.entry.content,
              toolCallId: input.entry.toolCallId ?? null,
              thinking: input.entry.thinking ?? null,
              metadata: input.entry.metadata ?? null,
            })
            .returning({ id: taskContext.id })
            .get() as unknown as { id: number };

          return { taskId: taskRow.id, entryId: entryRow.id };
        })();
        return result;
      },
      update: async (id: number, patch: UpdateTaskPatch): Promise<void> => {
        const set: Record<string, unknown> = { updatedAt: Date.now() };
        if (patch.status !== undefined) set["status"] = patch.status;
        if (patch.finalResult !== undefined) set["finalResult"] = patch.finalResult;
        if (patch.promptTokens !== undefined) set["promptTokens"] = patch.promptTokens;
        if (patch.completionTokens !== undefined) set["completionTokens"] = patch.completionTokens;
        if (patch.totalTokens !== undefined) set["totalTokens"] = patch.totalTokens;
        if (patch.toolCallCount !== undefined) set["toolCallCount"] = patch.toolCallCount;
        if (patch.iterationCount !== undefined) set["iterationCount"] = patch.iterationCount;
        if (patch.errorMessage !== undefined) set["errorMessage"] = patch.errorMessage;
        await db.update(tasks).set(set).where(eq(tasks.id, id)).run();
      },
      get: async (id: number): Promise<TaskRow | null> => {
        const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
        return row ? toTaskRow(row) : null;
      },
      listNonTerminal: async (): Promise<TaskRow[]> => {
        const rows = await db.select().from(tasks).all();
        return rows
          .filter((r) => r.status !== "done" && r.status !== "failed" && r.status !== "stopped")
          .map(toTaskRow);
      },
    };
  }

  close(): void {
    try {
      this.sqlite.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── First-run scaffolding ───────────────────────────────────────────────────

const DEFAULT_GITIGNORE = `# Auto-generated by huko on first run.
# Conversation DB and credentials should never be committed.
huko.db
huko.db-journal
huko.db-wal
huko.db-shm
keys.json
state.json
lock
`;

function ensureGitignore(hukoDir: string): void {
  const giPath = path.join(hukoDir, ".gitignore");
  if (existsSync(giPath)) return;
  try {
    writeFileSync(giPath, DEFAULT_GITIGNORE, { flag: "wx" });
  } catch {
    /* lost race with another writer; harmless */
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function migrationsDir(): string {
  // …/server/persistence/sqlite-session.{ts,js} → …/server/db/migrations/session
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "db", "migrations", "session");
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toChatSessionRow(r: typeof chatSessions.$inferSelect): ChatSessionRow {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toTaskRow(r: typeof tasks.$inferSelect): TaskRow {
  return {
    id: r.id,
    chatSessionId: r.chatSessionId,
    agentSessionId: r.agentSessionId,
    status: r.status,
    modelId: r.modelId,
    toolCallMode: r.toolCallMode,
    thinkLevel: r.thinkLevel,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    toolCallCount: r.toolCallCount,
    iterationCount: r.iterationCount,
    finalResult: r.finalResult,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toEntryRow(r: typeof taskContext.$inferSelect): EntryRow {
  return {
    id: r.id,
    taskId: r.taskId,
    sessionId: r.sessionId,
    sessionType: r.sessionType,
    kind: r.kind,
    role: r.role,
    content: r.content,
    toolCallId: r.toolCallId,
    thinking: r.thinking,
    metadata: r.metadata,
    createdAt: r.createdAt,
  };
}
