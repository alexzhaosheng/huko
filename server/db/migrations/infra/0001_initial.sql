-- 0001_initial.sql (infra DB)
-- Initial schema for the user-global infra DB.
--
-- Lives at ~/.huko/infra.db. Provider/model/system-default state.
-- Per-project conversation state is in a separate session DB.
--
-- Plaintext API keys are NEVER stored here. providers.api_key_ref holds
-- a logical name (e.g. "openrouter"); the actual key is resolved at
-- runtime via server/security/keys.ts.
--
-- Keep in sync with server/db/schema/infra.ts.

CREATE TABLE providers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  protocol        TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  api_key_ref     TEXT NOT NULL,
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
