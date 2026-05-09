/**
 * server/persistence/sqlite-infra.ts
 *
 * SQLite implementation of `InfraPersistence`. User-global DB at
 * `~/.huko/infra.db` (override via `opts.dbPath` for tests).
 *
 * Owns:
 *   - providers (with api_key_ref, NOT plaintext key)
 *   - models
 *   - app_config (system-level keys like default_model_id)
 *
 * Auto-creates the `~/.huko/` directory and runs migrations from
 * `server/db/migrations/infra/` on construction.
 */

import { eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database, {
  type Database as BetterSqlite3Database,
} from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "../db/migrate.js";
import * as schema from "../db/schema/infra.js";
import type {
  ConfigRow,
  CreateModelInput,
  CreateProviderInput,
  InfraPersistence,
  ModelRowJoined,
  ProviderRow,
  ResolvedModelConfig,
  UpdateProviderPatch,
} from "./types.js";

const { providers, models, appConfig } = schema;

type InfraDb = BetterSQLite3Database<typeof schema>;

export type SqliteInfraPersistenceOptions = {
  /** Override DB path (tests). Defaults to `~/.huko/infra.db`. */
  dbPath?: string;
};

export class SqliteInfraPersistence implements InfraPersistence {
  private readonly sqlite: BetterSqlite3Database;
  private readonly db: InfraDb;

  readonly providers: InfraPersistence["providers"];
  readonly models: InfraPersistence["models"];
  readonly config: InfraPersistence["config"];

  constructor(opts: SqliteInfraPersistenceOptions = {}) {
    const dbPath = opts.dbPath ?? defaultDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.db = drizzle(this.sqlite, { schema });

    runMigrations(this.sqlite, migrationsDir());

    const db = this.db;

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
            apiKeyRef: input.apiKeyRef,
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
        if (patch.apiKeyRef !== undefined) set["apiKeyRef"] = patch.apiKeyRef;
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
            apiKeyRef: providers.apiKeyRef,
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
          apiKeyRef: row.apiKeyRef,
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

// ─── Path helpers ────────────────────────────────────────────────────────────

function defaultDbPath(): string {
  return path.join(os.homedir(), ".huko", "infra.db");
}

function migrationsDir(): string {
  // …/server/persistence/sqlite-infra.{ts,js} → …/server/db/migrations/infra
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "db", "migrations", "infra");
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toProviderRow(r: typeof providers.$inferSelect): ProviderRow {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    baseUrl: r.baseUrl,
    apiKeyRef: r.apiKeyRef,
    defaultHeaders: r.defaultHeaders ?? null,
    createdAt: r.createdAt,
  };
}
