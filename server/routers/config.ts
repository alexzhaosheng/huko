/**
 * server/routers/config.ts
 *
 * `config.*` procedures — generic key-value access into app_config.
 *
 * Most-used keys (default_model_id) have dedicated procedures elsewhere
 * (model.setDefault). This router is the fallback for ui_theme,
 * stream_flush_ms, and similar.
 */

import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";

export const configRouter = router({
  get: publicProcedure
    .input(z.object({ key: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const value = await ctx.persistence.config.get(input.key);
      return { value };
    }),

  set: publicProcedure
    .input(z.object({ key: z.string().min(1).max(100), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.persistence.config.set(input.key, input.value);
      return { ok: true };
    }),

  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.persistence.config.list();
  }),
});
