/**
 * server/db/index.ts
 *
 * Barrel for the DB layer. There is NO global Drizzle handle anymore —
 * each persistence backend (SqliteInfraPersistence, SqliteSessionPersistence)
 * opens and owns its own better-sqlite3 + Drizzle pair.
 *
 * Consumers should import:
 *   - `./schema/infra.js`   for infra-DB tables
 *   - `./schema/session.js` for session-DB tables
 *   - `./adapter.js`        for the engine's PersistFn/UpdateFn factories
 *   - `./migrate.js`        for the per-handle migration runner
 *
 * This file just re-exports the schema namespaces for callers that
 * want both at once.
 */

export * as infraSchema from "./schema/infra.js";
export * as sessionSchema from "./schema/session.js";
export {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
  dbEntryToLLMMessage,
  type SessionDb,
} from "./adapter.js";
export { runMigrations, type MigrationResult } from "./migrate.js";
