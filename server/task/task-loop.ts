/**
 * server/task/task-loop.ts
 *
 * TaskLoop — the engine's main state machine.
 *
 * Per iteration:
 *   1. abort / iteration-budget guards
 *   2. drain one deferred tool call (single-step enforcement)
 *   3. callLLM
 *   4. dispatch on tool calls / final text / empty turn
 *   5. manageContext
 *
 * Behaviour counters live on ctx.behavior; the loop owns the abort
 * decision (MAX_EMPTY_RETRIES) and asks behavior for the right reminder
 * text (gentle vs escalated [Tool Use Enforcement]).
 *
 * Resume / orphan recovery is intentionally kept OUT of run() — it
 * lives in resume.ts and is a one-shot pre-loop pass.
 */

import { EntryKind, TERMINAL_STATUSES, type TaskStatus } from "../../shared/types.js";
import type { TaskContext } from "../engine/TaskContext.js";
import { callLLM } from "./pipeline/llm-call.js";
import { executeAndPersist } from "./pipeline/tool-execute.js";
import { manageContext } from "./pipeline/context-manage.js";
import { getConfig } from "../config/index.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type TaskRunSummary = {
  status: TaskStatus;
  finalResult: string;
  hasExplicitResult: boolean;
  toolCallCount: number;
  iterationCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Subset of `promptTokens` billed as prompt-cache READS by the
   * provider. 0 when the provider doesn't break it down (most
   * non-Anthropic, non-OpenAI servers).
   */
  cachedTokens: number;
  /**
   * Tokens written into the prompt cache (Anthropic specific). 0
   * elsewhere.
   */
  cacheCreationTokens: number;
  elapsedMs: number;
};

// ─── TaskLoop ─────────────────────────────────────────────────────────────────

export class TaskLoop {
  private running = false;

  constructor(public readonly ctx: TaskContext) {}

  async run(): Promise<TaskRunSummary> {
    if (this.running) {
      throw new Error("TaskLoop.run() called while already running.");
    }
    this.running = true;

    const ctx = this.ctx;

    const cfg = getConfig().task;
    const MAX_ITERATIONS = cfg.maxIterations;
    const MAX_TOOL_CALLS = cfg.maxToolCalls;
    const MAX_EMPTY_RETRIES = cfg.maxEmptyRetries;

    try {
      while (true) {
        if (ctx.isAborted) {
          ctx.taskStopped = true;
          break;
        }
        if (ctx.iterationCount >= MAX_ITERATIONS) {
          await this.appendFailureNotice(`Reached the iteration limit (${MAX_ITERATIONS}).`);
          ctx.taskFailed = true;
          break;
        }
        if (ctx.toolCallCount >= MAX_TOOL_CALLS) {
          await this.appendFailureNotice(`Reached the tool-call limit (${MAX_TOOL_CALLS}).`);
          ctx.taskFailed = true;
          break;
        }

        const deferred = ctx.deferredCalls.shift();
        if (deferred) {
          const outcome = await executeAndPersist(ctx, deferred);
          if (outcome.kind === "aborted") {
            ctx.taskStopped = true;
            break;
          }
          if (outcome.kind === "ok" && outcome.shouldBreak) {
            ctx.deferredCalls.length = 0;
            break;
          }
          await manageContext(ctx);
          continue;
        }

        ctx.consumeInterjectionFlag();

        const llmOutcome = await callLLM(ctx);

        if (llmOutcome.kind === "aborted") {
          if (llmOutcome.reason === "stopped") {
            ctx.taskStopped = true;
            break;
          }
          continue;
        }

        const result = llmOutcome.result;

        if (result.toolCalls.length > 0) {
          ctx.behavior.onProductiveTurn();
          const [first, ...rest] = result.toolCalls;
          if (rest.length > 0) ctx.deferredCalls.push(...rest);

          const toolOutcome = await executeAndPersist(ctx, first!);
          if (toolOutcome.kind === "aborted") {
            ctx.taskStopped = true;
            break;
          }
          if (toolOutcome.kind === "ok" && toolOutcome.shouldBreak) {
            ctx.deferredCalls.length = 0;
            break;
          }
          await manageContext(ctx);
          continue;
        }

        const trimmed = result.content.trim();
        if (trimmed.length > 0) {
          ctx.behavior.onProductiveTurn();
          ctx.finalResult = result.content;
          ctx.hasExplicitResult = true;
          break;
        }

        // Empty turn — guard tracks the streak and escalates the
        // reminder text on the second occurrence (gentle -> strong
        // "[Tool Use Enforcement]"). Loop owns the abort decision.
        const guardReminder = ctx.behavior.onEmptyTurn();
        if (ctx.behavior._emptyCount >= MAX_EMPTY_RETRIES) {
          await this.appendFailureNotice(
            "The model produced empty turns repeatedly. Aborting.",
          );
          ctx.taskFailed = true;
          break;
        }
        await ctx.sessionContext.appendReminder({
          taskId: ctx.taskId,
          reason: guardReminder.reason,
          content: guardReminder.content,
        });
      }
    } catch (err: unknown) {
      ctx.taskFailed = true;
      const msg = errorMessage(err);
      await this.appendFailureNotice(`Task crashed: ${msg}`);
      this.running = false;
      throw err;
    }

    this.running = false;

    const status = ctx.resolveStatus();
    if (!TERMINAL_STATUSES.has(status)) {
      throw new Error(`TaskLoop exited with non-terminal status "${status}".`);
    }

    return {
      status,
      finalResult: ctx.finalResult,
      hasExplicitResult: ctx.hasExplicitResult,
      ...ctx.summary(),
    };
  }

  // ─── External controls ──────────────────────────────────────────────────────

  interject(): void {
    this.ctx.interjected = true;
    this.ctx.behavior.resetOnUserInteraction();
    this.ctx.currentLlmAbort?.abort();
  }

  stop(): void {
    this.ctx.taskStopped = true;
    this.ctx.masterAbort.abort();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async appendFailureNotice(message: string): Promise<void> {
    try {
      await this.ctx.sessionContext.append({
        taskId: this.ctx.taskId,
        kind: EntryKind.StatusNotice,
        role: "system",
        content: message,
        metadata: { severity: "error" },
      });
    } catch {
      /* swallow — we're already in the error path */
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
