/**
 * server/routers/index.ts
 *
 * The tRPC `appRouter` root.
 *
 * Adding a domain: create `<domain>.ts`, export a `router(...)`, then add
 * one line below. The `AppRouter` type is exported for client-side type
 * inference — clients import `type { AppRouter }` from the server tree.
 */

import { router } from "./trpc.js";
import { chatRouter } from "./chat.js";
import { taskRouter } from "./task.js";
import { providerRouter } from "./provider.js";
import { modelRouter } from "./model.js";
import { configRouter } from "./config.js";

export const appRouter = router({
  chat: chatRouter,
  task: taskRouter,
  provider: providerRouter,
  model: modelRouter,
  config: configRouter,
});

export type AppRouter = typeof appRouter;

export type { Ctx } from "./context.js";
