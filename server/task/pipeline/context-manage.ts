/**
 * server/task/pipeline/context-manage.ts
 *
 * Context management — runs at the END of each loop iteration.
 *
 * Currently a STUB. The shape is in place so TaskLoop can call it
 * unconditionally; logic lands in subsequent rounds.
 *
 * Future responsibilities (mirroring WeavesAI):
 *   - Compaction: when context grows past a threshold, summarise older
 *     turns and `purgeMessages()` them out, replacing with a synthetic
 *     summary entry. Preserves recent turns verbatim.
 *   - File-exploration summaries: collapse long sequences of file
 *     reads into a structured digest entry.
 *   - System-reminder injection: e.g. "you've been quiet for a while —
 *     have you finished the user's task?".
 *
 * Note: the deferred-call queue (`ctx.deferredCalls`) is drained by
 * TaskLoop at the TOP of each iteration, not here. This module is for
 * shape-changing operations on already-persisted history.
 */

import type { TaskContext } from "../../engine/TaskContext.js";

export async function manageContext(_ctx: TaskContext): Promise<void> {
  // No-op for now. See file header for the planned responsibilities.
}
