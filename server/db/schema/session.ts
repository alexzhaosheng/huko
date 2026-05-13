/**
 * server/db/schema/session.ts
 *
 * Drizzle schema for the per-project session DB (<cwd>/.huko/huko.db).
 *
 * Tables here describe one project's conversation state:
 *   - chat_sessions  — top-level conversation containers
 *   - tasks          — one LLM exchange (potentially many turns) within a session
 *   - task_context   — every entry the model sees (user / assistant / tool / reminder)
 *
 * Provider / model / system-config tables live in a separate user-global
 * DB; see `./infra.ts`.
 *
 * DDL lives in `../migrations/session/*.sql`. Drift between this file
 * and the SQL is the author's responsibility — keep them in sync.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import type { ToolCallMode, ThinkLevel } from "../../core/llm/types.js";
import type { TaskStatus, SessionType } from "../../../shared/types.js";

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

// ─── session_substitutions ─── per-session secret-substitution table ─────────

export const sessionSubstitutions = sqliteTable(
  "session_substitutions",
  {
    sessionId: integer("session_id").notNull(),
    sessionType: text("session_type").$type<SessionType>().notNull(),
    placeholder: text("placeholder").notNull(),
    rawValue: text("raw_value").notNull(),
    /** "vault" or "scrub:<pattern-name>". */
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull().default(epochMs),
  },
  (table) => ({
    rawIdx: index("idx_session_substitutions_raw").on(
      table.sessionId,
      table.sessionType,
      table.rawValue,
    ),
  }),
);
