/**
 * server/routers/model.ts
 *
 * `model.*` procedures — CRUD + `setDefault` / `getDefault`.
 *
 * `list` returns models joined with their provider's name + protocol so
 * the UI doesn't need a second round-trip.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc.js";

const thinkLevelEnum = z.enum(["off", "low", "medium", "high"]);
const toolCallModeEnum = z.enum(["native", "xml"]);

export const modelRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.infra.models.list();
  }),

  create: publicProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        modelId: z.string().min(1).max(200),
        displayName: z.string().min(1).max(200).optional(),
        defaultThinkLevel: thinkLevelEnum.optional(),
        defaultToolCallMode: toolCallModeEnum.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const id = await ctx.infra.models.create({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName ?? input.modelId,
        ...(input.defaultThinkLevel !== undefined
          ? { defaultThinkLevel: input.defaultThinkLevel }
          : {}),
        ...(input.defaultToolCallMode !== undefined
          ? { defaultToolCallMode: input.defaultToolCallMode }
          : {}),
      });
      return { id };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const exists = await ctx.infra.models.resolveConfig(input.id);
      if (!exists) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.infra.models.delete(input.id);
      return { ok: true };
    }),

  setDefault: publicProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const exists = await ctx.infra.models.resolveConfig(input.modelId);
      if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Model not found." });
      await ctx.infra.config.setDefaultModelId(input.modelId);
      return { ok: true };
    }),

  getDefault: publicProcedure.query(async ({ ctx }) => {
    const modelId = await ctx.infra.config.getDefaultModelId();
    return { modelId };
  }),
});
