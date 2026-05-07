/**
 * server/task/task-loop.ts
 *
 * TaskLoop — the engine's main state machine.
 *
 * One loop iteration is roughly:
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ 1. abort / iteration-budget guards                                 │
 *   │ 2. drain one deferred tool call (single-step enforcement)          │
 *   │       └─ if drained: persist its result, continue to next iter     │
 *   │ 3. callLLM → LLMTurnResult                                         │
 *   │ 4. if turn has tool calls:                                         │
 *   │       execute first now, queue the rest into ctx.deferredCalls     │
 *   │    else if turn has content:                                       │
 *   │       record finalResult, exit loop (DONE)                         │
 *   │    else:                                                           │
 *   │       inject corrective system reminder, retry (bounded)           │
 *   │ 5. manageContext (compaction / digests, future)                    │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Why deferred calls are drained at the TOP of the iteration rather than
 * fired in a tight inner loop right after the LLM turn: each iteration
 * also re-checks `masterAbort` and the interjection flag, so a user
 * stop / interject between two queued calls actually takes effect.
 *
 * Resume / orphan recovery is intentionally kept OUT of `run()` — it
 * lives in `resume.ts` and is a one-shot pre-loop pass. `run()` only
 * does the clean forward path.
 */

import { EntryKind, TERMINAL_STATUSES, type TaskStatus } from "../../shared/types.js";
import type { TaskContext } from "../engine/TaskContext.js";
import { callLLM } from "./pipeline/llm-call.js";
import { executeAndPersist } from "./pipeline/tool-execute.js";
import { manageContext } from "./pipeline/context-manage.js";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Hard cap on LLM iterations per task. Defensive — runaway protection. */
const MAX_ITERATIONS = 200;
/** Hard cap on tool executions per task. */
const MAX_TOOL_CALLS = 200;
/** Bounded retries when the LLM emits empty content with no tool calls. */
const MAX_EMPTY_RETRIES = 3;

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
  elapsedMs: number;
};

// ─── TaskLoop ─────────────────────────────────────────────────────────────────

export class TaskLoop {
  private running = false;

  constructor(public readonly ctx: TaskContext) {}

  /**
   * Run the loop until a terminal state is reached.
   * Idempotent guard: a TaskLoop instance can only run once.
   */
  async run(): Promise<TaskRunSummary> {
    if (this.running) {
      throw new Error("TaskLoop.run() called while already running.");
    }
    this.running = true;

    const ctx = this.ctx;
    let consecutiveEmpty = 0;

    try {
      while (true) {
        // ── Guards ──────────────────────────────────────────────────────────
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

        // ── Drain one deferred call (skip LLM this iteration) ───────────────
        const deferred = ctx.deferredCalls.shift();
        if (deferred) {
          const outcome = await executeAndPersist(ctx, deferred);
          if (outcome.kind === "aborted") {
            ctx.taskStopped = true;
            break;
          }
          await manageContext(ctx);
          continue;
        }

        // Consume interjection flag — its sole job is to short-circuit
        // post-LLM-abort logic; if we're here it means the new user
        // message is already in context and we just call LLM normally.
        ctx.consumeInterjectionFlag();

        // ── Call the model ──────────────────────────────────────────────────
        const llmOutcome = await callLLM(ctx);

        if (llmOutcome.kind === "aborted") {
          if (llmOutcome.reason === "stopped") {
            ctx.taskStopped = true;
            break;
          }
          // Interjected: a new user message landed in context while the
          // call was in flight. Loop back; next iteration will re-call LLM.
          continue;
        }

        const result = llmOutcome.result;

        // ── Tool calls? execute first, defer rest ──────────────────────────
        if (result.toolCalls.length > 0) {
          consecutiveEmpty = 0;
          const [first, ...rest] = result.toolCalls;
          if (rest.length > 0) ctx.deferredCalls.push(...rest);

          const toolOutcome = await executeAndPersist(ctx, first!);
          if (toolOutcome.kind === "aborted") {
            ctx.taskStopped = true;
            break;
          }
          await manageContext(ctx);
          continue;
        }

        // ── No tool calls: either we're done, or LLM mis-fired ─────────────
        const trimmed = result.content.trim();
        if (trimmed.length > 0) {
          ctx.finalResult = result.content;
          ctx.hasExplicitResult = true;
          break;
        }

        // Empty turn — corrective nudge, bounded retries
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= MAX_EMPTY_RETRIES) {
          await this.appendFailureNotice(
            "The model produced empty turns repeatedly. Aborting.",
          );
          ctx.taskFailed = true;
          break;
        }
        await ctx.sessionContext.append({
          taskId: ctx.taskId,
          kind: EntryKind.SystemReminder,
          role: "user",
          content:
            "Your previous turn was empty. Either call a tool or reply to the user with a final answer.",
        });
      }
    } catch (err: unknown) {
      ctx.taskFailed = true;
      const msg = errorMessage(err);
      await this.appendFailureNotice(`Task crashed: ${msg}`);
      // Re-throw so the orchestrator can log; the summary still reports failed.
      this.running = false;
      throw err;
    }

    this.running = false;

    const status = ctx.resolveStatus();
    if (!TERMINAL_STATUSES.has(status)) {
      // Defensive — should never happen; resolveStatus is exhaustive.
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

  /**
   * User sent a new message while the task is running. The caller MUST
   * have already appended the user message to the session context before
   * calling this — interject() only signals; it does not persist.
   *
   * Behaviour: aborts only the current LLM call, not the whole task.
   * Tools in flight keep running (their results still get persisted).
   */
  interject(): void {
    this.ctx.interjected = true;
    this.ctx.currentLlmAbort?.abort();
  }

  /**
   * Hard stop. Aborts the master controller, which cancels both the
   * current LLM call (if any) and any currently-awaited tool. The loop
   * exits with status "stopped".
   */
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
