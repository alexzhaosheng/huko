/**
 * server/task/resume.ts
 *
 * Orphan recovery — runs at orchestrator startup. Scans for tasks in
 * non-terminal status (left over from a crashed/killed previous process)
 * and heals them so future LLM calls on the same session don't choke
 * on broken history.
 *
 * Three checkpoint shapes we recognise:
 *
 *   1. status="running" with dangling tool_calls
 *      The LLM emitted assistant(toolCalls=[...]) and the process died
 *      before tool_results landed. Anthropic / OpenAI / Gemini will all
 *      400 the next conversation if a tool_use has no matching
 *      tool_result.
 *      → Inject synthetic tool_result rows (one per dangling callId)
 *        with content "Error: tool execution interrupted by process
 *        termination." Pairing constraint preserved.
 *      → Mark task status=failed.
 *
 *   2. status="waiting_for_reply"
 *      Task paused on `message --type=ask`. The user never replied
 *      before the process died. (huko v1 doesn't yet emit this status,
 *      but defensive coverage is cheap.)
 *      → Mark task status=failed. Future enhancement: re-emit the ask
 *        event so the next process can pick up the prompt.
 *
 *   3. status="waiting_for_approval"
 *      Task paused awaiting `requestApproval`. Same shape as #2.
 *      → Mark task status=failed.
 *
 * What we do NOT do (v1):
 *   - Reconstruct TaskContext and continue the loop. That requires
 *     re-resolving model config + tools + executors — for huko's
 *     CLI-first scope, the simpler "mark failed, repair pairing" is
 *     enough. The user can `huko run --session=N "..."` (when that
 *     lands) to add a new task to the same session, and the synthetic
 *     tool_results will keep history valid.
 *   - Periodic re-scan (WeavesAI runs an OrphanRecovery health check
 *     every minute). Startup-once is sufficient for huko's CLI shape.
 */

import { EntryKind, type TaskStatus } from "../../shared/types.js";
import type { Persistence, EntryRow, TaskRow } from "../persistence/index.js";

export type RecoveryReport = {
  scanned: number;
  healed: number;
  byKind: {
    danglingTools: number;
    waitingForReply: number;
    waitingForApproval: number;
    other: number;
  };
};

/**
 * Scan for orphans and heal them. Idempotent — running this twice in
 * a row is safe (the second run finds nothing because the first marked
 * everything failed).
 */
export async function recoverOrphans(persistence: Persistence): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    scanned: 0,
    healed: 0,
    byKind: {
      danglingTools: 0,
      waitingForReply: 0,
      waitingForApproval: 0,
      other: 0,
    },
  };

  const orphans = await persistence.tasks.listNonTerminal();
  report.scanned = orphans.length;

  for (const task of orphans) {
    const sessionType = task.chatSessionId !== null ? "chat" : "agent";
    const sessionId = task.chatSessionId ?? task.agentSessionId;
    if (sessionId === null) {
      // Defensive: task without a session — mark failed.
      await markFailed(persistence, task, "orphan task has no session");
      report.byKind.other += 1;
      report.healed += 1;
      continue;
    }

    if (task.status === "waiting_for_reply") {
      await markFailed(persistence, task, "process exited while waiting for user reply");
      report.byKind.waitingForReply += 1;
      report.healed += 1;
      continue;
    }
    if (task.status === "waiting_for_approval") {
      await markFailed(persistence, task, "process exited while waiting for approval");
      report.byKind.waitingForApproval += 1;
      report.healed += 1;
      continue;
    }

    // Default ("running" / "pending"): scan for dangling tool_calls and
    // synthesise tool_results so the conversation stays valid for any
    // future continue-conversation call.
    const entries = await persistence.entries.listForSession(sessionId, sessionType);
    const taskEntries = entries.filter((e) => e.taskId === task.id);
    const dangling = findDanglingToolCalls(taskEntries);

    for (const callId of dangling) {
      await persistence.entries.persist({
        taskId: task.id,
        sessionId,
        sessionType,
        kind: EntryKind.ToolResult,
        role: "tool",
        content:
          "Error: tool execution was interrupted by process termination. " +
          "The result is unknown. (Synthesised by orphan recovery.)",
        toolCallId: callId,
        thinking: null,
        metadata: {
          toolName: "(unknown)",
          error: "interrupted",
          synthetic: true,
          source: "resume.ts",
        },
      });
    }

    if (dangling.length > 0) report.byKind.danglingTools += 1;
    else report.byKind.other += 1;

    await markFailed(
      persistence,
      task,
      dangling.length > 0
        ? `process exited mid-tool; ${dangling.length} synthetic tool_result(s) injected for pairing`
        : "process exited while running; no dangling tool_calls",
    );
    report.healed += 1;
  }

  return report;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function markFailed(
  persistence: Persistence,
  task: TaskRow,
  reason: string,
): Promise<void> {
  const patch: { status: TaskStatus; errorMessage: string } = {
    status: "failed",
    errorMessage: reason,
  };
  await persistence.tasks.update(task.id, patch);
}

/**
 * Walk a task's entries in chronological order. For each
 * `ai_message` whose metadata carries `toolCalls`, register all those
 * call ids as "open". For each `tool_result` with a matching
 * `toolCallId`, close it. Anything still open at the end is dangling.
 *
 * StatusNotice rows and SystemReminder rows are skipped — they don't
 * carry tool semantics. The walk preserves the original order so the
 * synthetic tool_result rows we inject end up adjacent to the assistant
 * message they pair with (modulo other entries between them, but the
 * pairing-by-callId is what matters to providers).
 */
function findDanglingToolCalls(entries: EntryRow[]): string[] {
  const open = new Map<string, true>();

  for (const e of entries) {
    if (e.kind === EntryKind.AiMessage) {
      const meta = e.metadata as Record<string, unknown> | null;
      const tcs = meta?.["toolCalls"] as Array<{ id?: string }> | undefined;
      if (tcs) {
        for (const tc of tcs) {
          if (tc && typeof tc.id === "string") open.set(tc.id, true);
        }
      }
    } else if (e.kind === EntryKind.ToolResult && e.toolCallId) {
      open.delete(e.toolCallId);
    }
  }

  return [...open.keys()];
}
