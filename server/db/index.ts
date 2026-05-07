/**
 * server/db/index.ts
 *
 * Public surface of the DB layer.
 */

export * from "./schema.js";
export { db, sqlite, type Db } from "./client.js";
export { runMigrations, type MigrationResult } from "./migrate.js";
export {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
  dbEntryToLLMMessage,
} from "./adapter.js";
