/**
 * server/routers/context.ts
 *
 * The tRPC context type.
 *
 * Single-user — no auth, no per-request user. The context is the shared
 * singletons every procedure can reach: the two persistence backends and
 * the task orchestrator. The Express adapter calls `createContext()` once
 * per request and we hand back the same object.
 *
 *   - `infra`   user-global (providers, models, system defaults)
 *   - `session` per-project (chat sessions, tasks, entries)
 *
 * Procedures pick whichever they need; most touch only one.
 */

import type {
  InfraPersistence,
  SessionPersistence,
} from "../persistence/index.js";
import type { TaskOrchestrator } from "../services/index.js";

export type Ctx = {
  infra: InfraPersistence;
  session: SessionPersistence;
  orchestrator: TaskOrchestrator;
};
