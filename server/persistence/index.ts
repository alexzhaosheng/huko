/**
 * server/persistence/index.ts
 *
 * Public surface of the persistence layer.
 *
 * Two separate interfaces, two separate scopes:
 *   - InfraPersistence    user-global  (~/.huko/infra.db)
 *   - SessionPersistence  per-project  (<cwd>/.huko/huko.db)
 *
 * Consumers (orchestrator, routers, app.ts) hold one or both depending
 * on what they need. The combined `Persistence` interface from v0.1
 * has been removed.
 *
 * Adding a new built-in implementation:
 *   1. Drop a file under this directory implementing one or both interfaces.
 *   2. Re-export its class below.
 */

export type {
  // Interfaces
  InfraPersistence,
  SessionPersistence,
  // Row shapes
  ChatSessionRow,
  TaskRow,
  EntryRow,
  ProviderRow,
  ModelRow,
  ModelRowJoined,
  ResolvedModelConfig,
  ConfigRow,
  // Inputs
  CreateChatSessionInput,
  CreateTaskInput,
  UpdateTaskPatch,
  CreateProviderInput,
  UpdateProviderPatch,
  CreateModelInput,
} from "./types.js";

export {
  SqliteInfraPersistence,
  type SqliteInfraPersistenceOptions,
} from "./sqlite-infra.js";
export {
  SqliteSessionPersistence,
  type SqliteSessionPersistenceOptions,
} from "./sqlite-session.js";
export {
  MemoryInfraPersistence,
  MemorySessionPersistence,
  collectElidedEntryIds,
} from "./memory.js";
