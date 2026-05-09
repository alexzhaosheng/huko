-- 0001_initial.sql (session DB)
-- Initial schema for a per-project session DB.
--
-- Lives at <cwd>/.huko/huko.db. Conversation state for ONE project:
-- chat sessions, the LLM tasks within them, and every entry the model
-- has seen.
--
-- User-global provider/model state is in a separate infra DB.
--
-- Keep in sync with server/db/schema/session.ts.

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
