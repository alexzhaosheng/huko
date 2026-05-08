/**
 * server/routers/context.ts
 *
 * The tRPC context type.
 *
 * Single-user — no auth, no per-request user. The context is the shared
 * singletons every procedure can reach: the persistence backend and the
 * task orchestrator. The Express adapter calls `createContext()` once
 * per request and we hand back the same object.
 *
 * `db` is gone — kernel and routers go through `Persistence` now.
 */

import type { Persistence } from "../persistence/index.js";
import type { TaskOrchestrator } from "../services/index.js";

export type Ctx = {
  persistence: Persistence;
  orchestrator: TaskOrchestrator;
};
