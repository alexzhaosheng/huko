-- 0001_initial.sql
-- Initial schema for huko.
--
-- huko is single-user. No `users` table, no auth, no per-user scoping.
-- Keep in sync with server/db/schema.ts.

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

CREATE TABLE providers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  protocol        TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  api_key         TEXT NOT NULL,
  default_headers TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE models (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id             INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id                TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  default_think_level     TEXT NOT NULL DEFAULT 'off',
  default_tool_call_mode  TEXT NOT NULL DEFAULT 'native',
  created_at              INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_models_provider ON models(provider_id);

CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
