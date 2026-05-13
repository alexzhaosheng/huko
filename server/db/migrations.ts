/**
 * server/db/migrations.ts
 *
 * Schema migrations for both DB scopes, embedded as TypeScript
 * constants. esbuild bundles this file into dist/cli.js, so migrations
 * work identically in dev (tsx) and production (bundled CLI) — no
 * runtime filesystem lookups, no path resolution that depends on
 * source layout vs bundle layout.
 *
 * The previous design loaded `.sql` files relative to
 * `import.meta.url`. That broke as soon as the code moved into a
 * bundle: the .sql files weren't shipped, and even if they had been
 * the relative path differed between dev and dist. The bug surfaced
 * as `huko` failing with `no such table: tasks` in any directory
 * a published / built huko was used in. Inlining the SQL eliminates
 * the failure mode entirely.
 *
 * Each migration is a `{version, sql}` pair. `runMigrations` applies
 * them in array order, recording each version in `_migrations`. To
 * add a migration:
 *   - Push a new entry at the END of the relevant array.
 *   - Never mutate or reorder existing entries — versions on disk
 *     reference them by name, and reordering would re-run already-
 *     applied DDL or skip new DDL.
 *
 * Keep these in sync with `server/db/schema/{infra,session}.ts`.
 */

export type Migration = {
  version: string;
  sql: string;
};


// ─── session DB (<cwd>/.huko/huko.db) ────────────────────────────────────────

export const sessionMigrations: Migration[] = [
  {
    version: "0001_initial",
    sql: `
CREATE TABLE chat_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_session_id  INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',
  model_id          TEXT NOT NULL,
  tool_call_mode    TEXT NOT NULL,
  think_level       TEXT NOT NULL DEFAULT 'off',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  iteration_count   INTEGER NOT NULL DEFAULT 0,
  final_result      TEXT NOT NULL DEFAULT '',
  error_message     TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_tasks_chat_session ON tasks(chat_session_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_context (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL,
  session_type  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tool_call_id  TEXT,
  thinking      TEXT,
  metadata      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_task_context_session ON task_context(session_id, session_type, id);
CREATE INDEX idx_task_context_task ON task_context(task_id);
`,
  },
  {
    // Adds the per-session secret-substitution table that backs the
    // redaction system (vault hits + auto-discovered regex hits).
    // Strict primary key on (session_id, session_type, placeholder)
    // because the scrubber's idempotence rule says: same placeholder
    // within a session means same raw value, always.
    version: "0002_session_substitutions",
    sql: `
CREATE TABLE session_substitutions (
  session_id    INTEGER NOT NULL,
  session_type  TEXT NOT NULL,
  placeholder   TEXT NOT NULL,
  raw_value     TEXT NOT NULL,
  source        TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (session_id, session_type, placeholder)
);
CREATE INDEX idx_session_substitutions_raw
  ON session_substitutions(session_id, session_type, raw_value);
`,
  },
];
