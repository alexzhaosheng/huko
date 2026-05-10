/**
 * server/db/index.ts
 *
 * Barrel for the DB layer. Each persistence backend opens and owns
 * its own better-sqlite3 + Drizzle pair — there is NO global handle.
 *
 * After the infra refactor (providers/models moved to JSON), only the
 * session schema is exposed here.
 *
 * Consumers should import:
 *   - `./schema/session.js` for session-DB tables
 *   - `./adapter.js`        for the engine's PersistFn/UpdateFn factories
 *   - `./migrate.js`        for the per-handle migration runner
 */

export * as sessionSchema from "./schema/session.js";
export {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
  dbEntryToLLMMessage,
  type SessionDb,
} from "./adapter.js";
export { runMigrations, type MigrationResult } from "./migrate.js";
