/**
 * server/routers/provider.ts
 *
 * `provider.*` procedures — CRUD for LLM API endpoints.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc.js";

const protocolEnum = z.enum(["openai", "anthropic"]);

export const providerRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.persistence.providers.list();
  }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        protocol: protocolEnum,
        baseUrl: z.string().url().max(500),
        apiKey: z.string().min(1).max(500),
        defaultHeaders: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const id = await ctx.persistence.providers.create({
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        ...(input.defaultHeaders !== undefined ? { defaultHeaders: input.defaultHeaders } : {}),
      });
      return { id };
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        protocol: protocolEnum.optional(),
        baseUrl: z.string().url().max(500).optional(),
        apiKey: z.string().min(1).max(500).optional(),
        defaultHeaders: z.record(z.string(), z.string()).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Conditional spread — `exactOptionalPropertyTypes` forbids passing
      // explicit `undefined` for absent optional fields.
      await ctx.persistence.providers.update(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.defaultHeaders !== undefined ? { defaultHeaders: input.defaultHeaders } : {}),
      });
      return { ok: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const list = await ctx.persistence.providers.list();
      if (!list.find((p) => p.id === input.id)) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.persistence.providers.delete(input.id);
      return { ok: true };
    }),
});
