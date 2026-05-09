/**
 * server/persistence/sqlite.ts
 *
 * DEPRECATED barrel: the combined `SqlitePersistence` was split into
 * `SqliteInfraPersistence` (~/.huko/infra.db) and `SqliteSessionPersistence`
 * (<cwd>/.huko/huko.db). New code should import directly from the two
 * sibling files; this file remains for now as a compatibility re-export.
 */

export {
  SqliteInfraPersistence,
  type SqliteInfraPersistenceOptions,
} from "./sqlite-infra.js";
export {
  SqliteSessionPersistence,
  type SqliteSessionPersistenceOptions,
} from "./sqlite-session.js";
