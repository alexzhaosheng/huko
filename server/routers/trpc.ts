/**
 * server/routers/trpc.ts
 *
 * tRPC builder bootstrap. Every router file imports `router` and
 * `publicProcedure` from here.
 *
 * No middleware (single-user, no auth). If we ever need request-scoped
 * concerns (rate limiting, request logging) they hang off `t.middleware`.
 */

import { initTRPC } from "@trpc/server";
import type { Ctx } from "./context.js";

const t = initTRPC.context<Ctx>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
