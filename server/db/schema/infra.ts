/**
 * server/db/schema/infra.ts
 *
 * Drizzle schema for the user-global infra DB (~/.huko/infra.db).
 *
 * Tables here describe the user's "personal toolbox":
 *   - providers   — LLM provider endpoints + an api_key_ref name
 *   - models      — model definitions linked to providers
 *   - app_config  — kv bag for system-level defaults (default_model_id ...)
 *
 * Per-project conversation state (sessions / tasks / entries) lives in a
 * separate DB; see `./session.ts`.
 *
 * Plaintext API keys are NEVER stored in this DB. `providers.api_key_ref`
 * holds a logical name like "openrouter"; the actual secret is resolved
 * at runtime by `server/security/keys.ts` from one of:
 *   1. <cwd>/.huko/keys.json
 *   2. process.env (e.g. OPENROUTER_API_KEY)
 *   3. <cwd>/.env
 *
 * DDL lives in `../migrations/infra/*.sql`. Drift between this file and
 * the SQL is the author's responsibility — keep them in sync.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import type { ToolCallMode, ThinkLevel, Protocol } from "../../core/llm/types.js";

/** SQL expression: current time in epoch milliseconds. */
const epochMs = sql`(unixepoch() * 1000)`;

// ─── providers ───────────────────────────────────────────────────────────────

export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  protocol: text("protocol").$type<Protocol>().notNull(),
  baseUrl: text("base_url").notNull(),
  /**
   * Logical name used to look up the provider's API key at runtime
   * (e.g. "openrouter" → `OPENROUTER_API_KEY` env var or
   * `<cwd>/.huko/keys.json["openrouter"]`).
   *
   * Convention: lowercase ASCII, `[a-z0-9_-]+`. The keys.ts resolver
   * uppercases and replaces non-`[A-Z0-9]` with `_` before looking up
   * env vars, so `my-corp.gateway` becomes `MY_CORP_GATEWAY_API_KEY`.
   */
  apiKeyRef: text("api_key_ref").notNull(),
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

// ─── app_config ─── system-level kv settings ─────────────────────────────────

/**
 * Key-value bag for things that don't fit the typed tables but need to
 * persist across restarts. Kept deliberately schema-less — anything more
 * structured deserves its own table.
 *
 * Conventional keys:
 *   - "default_model_id"      → number (FK to models.id, by convention)
 *
 * `value` is JSON-encoded so primitives, arrays, and objects all work.
 */
export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at").notNull().default(epochMs),
});
