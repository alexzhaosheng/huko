/**
 * server/persistence/sqlite.ts
 *
 * The SQLite implementation of `Persistence`.
 *
 * Wraps `server/db/` (better-sqlite3 + Drizzle). The Drizzle queries that
 * used to live scattered across the orchestrator and tRPC routers are
 * consolidated here — the rest of the kernel speaks `Persistence`.
 *
 * Underneath better-sqlite3 is synchronous; these methods are typed
 * `Promise<T>` to match the interface but resolve immediately.
 *
 * Construction:
 *   new SqlitePersistence()                  // uses the singleton db
 *   new SqlitePersistence({ db, sqlite })    // inject explicitly (tests)
 */

import { eq, and, asc, desc } from "drizzle-orm";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import {
  db as defaultDb,
  sqlite as defaultSqlite,
  type Db,
} from "../db/client.js";
import {
  chatSessions,
  tasks,
  taskContext,
  providers,
  models,
  appConfig,
} from "../db/schema.js";
import {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
} from "../db/adapter.js";
import type {
  ChatSessionRow,
  ConfigRow,
  CreateChatSessionInput,
  CreateModelInput,
  CreateProviderInput,
  CreateTaskInput,
  EntryRow,
  ModelRowJoined,
  Persistence,
  ProviderRow,
  ResolvedModelConfig,
  TaskRow,
  UpdateProviderPatch,
  UpdateTaskPatch,
} from "./types.js";
import type { LLMMessage } from "../core/llm/types.js";
import type { SessionType } from "../../shared/types.js";

export type SqlitePersistenceOptions = {
  db?: Db;
  sqlite?: BetterSqlite3Database;
};

export class SqlitePersistence implements Persistence {
  private readonly db: Db;
  private readonly sqlite: BetterSqlite3Database;

  readonly entries: Persistence["entries"];
  readonly sessions: Persistence["sessions"];
  readonly tasks: Persistence["tasks"];
  readonly providers: Persistence["providers"];
  readonly models: Persistence["models"];
  readonly config: Persistence["config"];

  constructor(opts: SqlitePersistenceOptions = {}) {
    this.db = opts.db ?? defaultDb;
    this.sqlite = opts.sqlite ?? defaultSqlite;
    const db = this.db;

    // ── entries (Tier 1) ────────────────────────────────────────────────────
    this.entries = {
      persist: makePersistEntry(db),
      update: makeUpdateEntry(db),
      loadLLMContext: (sessionId: number, type: SessionType): Promise<LLMMessage[]> =>
        loadSessionLLMContext(db, sessionId, type),
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
    };

    // ── providers ──────────────────────────────────────────────────────────
    this.providers = {
      list: async (): Promise<ProviderRow[]> => {
        const rows = await db.select().from(providers).all();
        return rows.map(toProviderRow);
      },
      create: async (input: CreateProviderInput): Promise<number> => {
        const row = await db
          .insert(providers)
          .values({
            name: input.name,
            protocol: input.protocol,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            defaultHeaders: input.defaultHeaders ?? null,
          })
          .returning({ id: providers.id })
          .get();
        return row.id;
      },
      update: async (id: number, patch: UpdateProviderPatch): Promise<void> => {
        const set: Record<string, unknown> = {};
        if (patch.name !== undefined) set["name"] = patch.name;
        if (patch.protocol !== undefined) set["protocol"] = patch.protocol;
        if (patch.baseUrl !== undefined) set["baseUrl"] = patch.baseUrl;
        if (patch.apiKey !== undefined) set["apiKey"] = patch.apiKey;
        if (patch.defaultHeaders !== undefined) set["defaultHeaders"] = patch.defaultHeaders;
        if (Object.keys(set).length === 0) return;
        await db.update(providers).set(set).where(eq(providers.id, id)).run();
      },
      delete: async (id: number): Promise<void> => {
        await db.delete(providers).where(eq(providers.id, id)).run();
      },
    };

    // ── models ─────────────────────────────────────────────────────────────
    this.models = {
      list: async (): Promise<ModelRowJoined[]> => {
        const rows = await db
          .select({
            id: models.id,
            providerId: models.providerId,
            modelId: models.modelId,
            displayName: models.displayName,
            defaultThinkLevel: models.defaultThinkLevel,
            defaultToolCallMode: models.defaultToolCallMode,
            createdAt: models.createdAt,
            providerName: providers.name,
            providerProtocol: providers.protocol,
          })
          .from(models)
          .innerJoin(providers, eq(models.providerId, providers.id))
          .all();
        return rows.map((r) => ({
          id: r.id,
          providerId: r.providerId,
          modelId: r.modelId,
          displayName: r.displayName,
          defaultThinkLevel: r.defaultThinkLevel,
          defaultToolCallMode: r.defaultToolCallMode,
          createdAt: r.createdAt,
          providerName: r.providerName,
          providerProtocol: r.providerProtocol,
        }));
      },
      create: async (input: CreateModelInput): Promise<number> => {
        const row = await db
          .insert(models)
          .values({
            providerId: input.providerId,
            modelId: input.modelId,
            displayName: input.displayName,
            defaultThinkLevel: input.defaultThinkLevel ?? "off",
            defaultToolCallMode: input.defaultToolCallMode ?? "native",
          })
          .returning({ id: models.id })
          .get();
        return row.id;
      },
      delete: async (id: number): Promise<void> => {
        await db.delete(models).where(eq(models.id, id)).run();
      },
      resolveConfig: async (modelId: number): Promise<ResolvedModelConfig | null> => {
        const row = await db
          .select({
            modelId: models.modelId,
            defaultThinkLevel: models.defaultThinkLevel,
            defaultToolCallMode: models.defaultToolCallMode,
            protocol: providers.protocol,
            baseUrl: providers.baseUrl,
            apiKey: providers.apiKey,
            defaultHeaders: providers.defaultHeaders,
          })
          .from(models)
          .innerJoin(providers, eq(models.providerId, providers.id))
          .where(eq(models.id, modelId))
          .get();
        if (!row) return null;
        return {
          modelId: row.modelId,
          protocol: row.protocol,
          baseUrl: row.baseUrl,
          apiKey: row.apiKey,
          toolCallMode: row.defaultToolCallMode,
          thinkLevel: row.defaultThinkLevel,
          defaultHeaders: row.defaultHeaders ?? null,
        };
      },
    };

    // ── config ─────────────────────────────────────────────────────────────
    this.config = {
      get: async (key: string): Promise<unknown> => {
        const row = await db.select().from(appConfig).where(eq(appConfig.key, key)).get();
        return row?.value ?? null;
      },
      set: async (key: string, value: unknown): Promise<void> => {
        const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).get();
        if (existing) {
          await db
            .update(appConfig)
            .set({ value, updatedAt: Date.now() })
            .where(eq(appConfig.key, key))
            .run();
        } else {
          await db.insert(appConfig).values({ key, value }).run();
        }
      },
      list: async (): Promise<ConfigRow[]> => {
        const rows = await db.select().from(appConfig).all();
        return rows.map((r) => ({
          key: r.key,
          value: r.value,
          updatedAt: r.updatedAt,
        }));
      },
      getDefaultModelId: async (): Promise<number | null> => {
        const row = await db
          .select()
          .from(appConfig)
          .where(eq(appConfig.key, "default_model_id"))
          .get();
        const v = row?.value;
        return typeof v === "number" ? v : null;
      },
      setDefaultModelId: async (modelId: number): Promise<void> => {
        await this.config.set("default_model_id", modelId);
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

function toProviderRow(r: typeof providers.$inferSelect): ProviderRow {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    defaultHeaders: r.defaultHeaders ?? null,
    createdAt: r.createdAt,
  };
}
