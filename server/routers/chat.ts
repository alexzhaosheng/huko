/**
 * server/routers/chat.ts
 *
 * `chat.*` procedures — sessions and message sending.
 *
 * Note: `sendMessage` returns only the task id and an interjected flag.
 * The orchestrator's `completion` Promise is intentionally NOT serialised
 * to the client — the client subscribes to the session's WebSocket room
 * and watches `task:done` / `task:error` / `task:stopped` instead.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc.js";

export const chatRouter = router({
  create: publicProcedure
    .input(z.object({ title: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const id = await ctx.orchestrator.createChatSession(input.title ?? "");
      return { id };
    }),

  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.persistence.sessions.list();
  }),

  get: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const session = await ctx.persistence.sessions.get(input.id);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Chat session not found." });
      }
      const entries = await ctx.persistence.entries.listForSession(input.id, "chat");
      return { session, entries };
    }),

  sendMessage: publicProcedure
    .input(
      z.object({
        chatSessionId: z.number().int().positive(),
        content: z.string().min(1).max(50_000),
        modelId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.orchestrator.sendUserMessage({
        chatSessionId: input.chatSessionId,
        content: input.content,
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      });
      return { taskId: result.taskId, interjected: result.interjected };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.orchestrator.deleteChatSession(input.id);
      return { ok: true };
    }),
});
