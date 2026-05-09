/**
 * server/routers/task.ts
 *
 * `task.*` procedures — control and status of a running task.
 *
 * Stop is fire-and-forget — the actual termination event arrives over
 * WebSocket as `task:stopped`. The mutation returns immediately with a
 * boolean indicating whether the stop signal was actually delivered (i.e.
 * the task was live).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc.js";

export const taskRouter = router({
  stop: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      const stopped = ctx.orchestrator.stop(input.id);
      return { stopped };
    }),

  get: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.session.tasks.get(input.id);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
      }
      return row;
    }),
});
