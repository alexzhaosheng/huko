/**
 * server/persistence/index.ts
 *
 * Public surface of the (session) persistence layer.
 *
 * Provider/model/system-default config moved out of SQLite into
 * layered JSON files — see `server/config/infra-config.ts`. This
 * module now only deals with `SessionPersistence` (chat sessions,
 * tasks, entry log).
 *
 * Adding a new built-in implementation:
 *   1. Drop a file under this directory implementing `SessionPersistence`.
 *   2. Re-export its class below.
 */

export type {
  // Interface
  SessionPersistence,
  // Row shapes
  ChatSessionRow,
  TaskRow,
  EntryRow,
  // Inputs
  CreateChatSessionInput,
  CreateTaskInput,
  UpdateTaskPatch,
  InitialEntryInput,
  CreateTaskWithInitialEntryInput,
} from "./types.js";

export {
  SqliteSessionPersistence,
  type SqliteSessionPersistenceOptions,
} from "./sqlite-session.js";

export {
  MemorySessionPersistence,
  collectElidedEntryIds,
} from "./memory.js";
