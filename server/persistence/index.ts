/**
 * server/persistence/index.ts
 *
 * Public surface of the persistence layer.
 *
 * Consumers (orchestrator, routers, app.ts) import the `Persistence`
 * interface and one of the built-in implementations from here.
 *
 * Adding a new built-in implementation:
 *   1. Drop a file under this directory implementing `Persistence`.
 *   2. Re-export its class below.
 *
 * Adding an external implementation (npm package):
 *   - Ship `huko-persistence-<name>` exporting a class implementing
 *     `Persistence`. No change needed in this barrel.
 */

export type {
  Persistence,
  ChatSessionRow,
  TaskRow,
  EntryRow,
  ProviderRow,
  ModelRow,
  ModelRowJoined,
  ResolvedModelConfig,
  ConfigRow,
  CreateChatSessionInput,
  CreateTaskInput,
  UpdateTaskPatch,
  CreateProviderInput,
  UpdateProviderPatch,
  CreateModelInput,
} from "./types.js";

export { SqlitePersistence, type SqlitePersistenceOptions } from "./sqlite.js";
export { MemoryPersistence } from "./memory.js";
export { FilePersistence, type FilePersistenceOptions } from "./file.js";
