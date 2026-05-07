/**
 * server/db/schema.ts
 *
 * Drizzle schema definitions — source of truth for query types.
 *
 * The actual DDL lives in `migrations/*.sql`. We do NOT use drizzle-kit
 * to generate migrations: keeping migrations as hand-authored SQL files
 * gives us complete control (especially for SQLite, which has limited
 * ALTER TABLE support and often needs the new-table-copy-data dance).
 *
 * Drift between this file and the SQL is caught at compile time only
 * when query code references a column that doesn't exist (TS error).
 * For runtime safety, every schema change must update BOTH this file
 * AND a new migration file.
 *
 * huko is single-user. There is NO `users` table, NO auth, NO per-user
 * scoping. The DB is essentially:
 *   - chat_sessions / tasks / task_context — the conversation log
 *   - providers / models / app_config       — lightweight global config
 */

import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import type { ToolCallMode, ThinkLevel, Protocol } from "../core/llm/types.js";
import type { TaskStatus, SessionType } from "../../shared/types.js";

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** SQL expression: current time in epoch milliseconds. */
const epochMs = sql`(unixepoch() * 1000)`;

// ─── chat_sessions ────────────────────────────────────────────────────────────

export const chatSessions = sqliteTable("chat_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull().default(""),
  createdAt: integer("created_at").notNull().default(epochMs),
  updatedAt: integer("updated_at").notNull().default(epochMs),
});

// ─── tasks ────────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Either chatSessionId or agentSessionId is populated, not both. */
    chatSessionId: integer("chat_session_id").references(() => chatSessions.id, {
      onDelete: "cascade",
    }),
    agentSessionId: integer("agent_session_id"),
    status: text("status").$type<TaskStatus>().notNull().default("pending"),
    modelId: text("model_id").notNull(),
    toolCallMode: text("tool_call_mode").$type<ToolCallMode>().notNull(),
    thinkLevel: text("think_level").$type<ThinkLevel>().notNull().default("off"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    iterationCount: integer("iteration_count").notNull().default(0),
    finalResult: text("final_result").notNull().default(""),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull().default(epochMs),
    updatedAt: integer("updated_at").notNull().default(epochMs),
  },
  (table) => ({
    chatIdx: index("idx_tasks_chat_session").on(table.chatSessionId),
    statusIdx: index("idx_tasks_status").on(table.status),
  }),
);

// ─── task_context ─── single source of truth for conversation entries ─────────

export const taskContext = sqliteTable(
  "task_context",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /**
     * The owning session. We duplicate this on every entry (denormalised)
     * so we can load a session's full history without a JOIN through
     * tasks. Sessions outlive individual tasks.
     */
    sessionId: integer("session_id").notNull(),
    sessionType: text("session_type").$type<SessionType>().notNull(),
    /** EntryKind value. Not enum-typed in DB so future kinds don't need migrations. */
    kind: text("kind").notNull(),
    role: text("role", {
      enum: ["system", "user", "assistant", "tool"] as const,
    }).notNull(),
    content: text("content").notNull(),
    /** For tool-result entries: the call.id this responds to. */
    toolCallId: text("tool_call_id"),
    /** Reasoning content, if the model emitted any. */
    thinking: text("thinking"),
    /**
     * JSON blob. Holds toolCalls (for assistant entries), attachments,
     * usage, and any other per-entry side data. Mode "json" auto-parses
     * on read and stringifies on write.
     */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull().default(epochMs),
  },
  (table) => ({
    sessionIdx: index("idx_task_context_session").on(
      table.sessionId,
      table.sessionType,
      table.id,
    ),
    taskIdx: index("idx_task_context_task").on(table.taskId),
  }),
);

// ─── providers ───────────────────────────────────────────────────────────────

export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  protocol: text("protocol").$type<Protocol>().notNull(),
  baseUrl: text("base_url").notNull(),
  /** TODO: encrypt at rest. Plaintext for MVP — single-user dev setup. */
  apiKey: text("api_key").notNull(),
  /** JSON-encoded headers (e.g. OpenRouter HTTP-Referer / X-Title). */
  defaultHeaders: text("default_headers", { mode: "json" }).$type<
    Record<string, string>
  >(),
  createdAt: integer("created_at").notNull().default(epochMs),
});

// ─── models ──────────────────────────────────────────────────────────────────

export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    /** Vendor's model identifier, e.g. "anthropic/claude-opus-4-5". */
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    defaultThinkLevel: text("default_think_level")
      .$type<ThinkLevel>()
      .notNull()
      .default("off"),
    defaultToolCallMode: text("default_tool_call_mode")
      .$type<ToolCallMode>()
      .notNull()
      .default("native"),
    createdAt: integer("created_at").notNull().default(epochMs),
  },
  (table) => ({
    providerIdx: index("idx_models_provider").on(table.providerId),
  }),
);

// ─── app_config ─── global key-value settings ────────────────────────────────

/**
 * Key-value bag for things that don't fit the typed tables but need to
 * persist across restarts. Kept deliberately schema-less — anything more
 * structured deserves its own table.
 *
 * Conventional keys:
 *   - "default_model_id"      → number (FK to models.id, by convention)
 *   - "ui_theme"              → "light" | "dark" | "system"
 *   - "stream_flush_ms"       → number (override pipeline default)
 *
 * `value` is JSON-encoded so primitives, arrays, and objects all work.
 */
export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at").notNull().default(epochMs),
});
