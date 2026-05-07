/**
 * server/task/resume.ts
 *
 * Resume / orphan-recovery for tasks that were interrupted by a crash
 * or process restart.
 *
 * STUB. The shape is in place; logic lands once we have the DB layer
 * and `task_context` schema solid enough to query reliably.
 *
 * Future responsibilities (mirroring WeavesAI):
 *   - Detect a task whose `status` was non-terminal at process exit.
 *   - Rebuild SessionContext / TaskContext from `task_context` history.
 *   - Repair three orphan states:
 *       ① `waiting_for_reply` — there is an unanswered ask checkpoint;
 *          surface it to the user again instead of re-asking the LLM.
 *       ② `waiting_for_approval` — same idea for approval prompts.
 *       ③ `running` with an in-flight tool call that never completed —
 *          inject a synthetic tool_result entry recording the
 *          interruption so the LLM can decide to retry or move on.
 *   - Hand the recovered TaskContext off to a fresh TaskLoop.run().
 *
 * The contract guarantees TaskLoop.run() itself never knows about
 * resume — it only does the clean forward path.
 */

import type { TaskContext } from "../engine/TaskContext.js";

export type ResumeOutcome =
  | { kind: "fresh" /* nothing to recover */ }
  | { kind: "recovered"; orphansFixed: number }
  | { kind: "abandoned"; reason: string };

/**
 * STUB — always returns "fresh". Replace with real logic once we have:
 *   - DB schema for `tasks` and `task_context`
 *   - Loaders to rehydrate SessionContext.llmContext from history
 *   - Synthesis helpers for orphan-recovery entries
 */
export async function resumeTask(_ctx: TaskContext): Promise<ResumeOutcome> {
  return { kind: "fresh" };
}
