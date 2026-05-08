/**
 * server/cli/formatters/types.ts
 *
 * Formatter contract — every output mode (text / jsonl / json) implements this.
 *
 *   - `emitter` receives every `HukoEvent` for the run.
 *   - `onTaskStarted` is called once after `sendUserMessage` returns.
 *   - `onSummary` is called when the task reaches a terminal state cleanly.
 *   - `onError` is called if the run promise rejects.
 *
 * Output discipline (kept consistent across formatters):
 *   - stdout  is the formatter-specific "result" stream
 *               (text:   the assistant's final answer
 *                jsonl:  one JSON line per event
 *                json:   one final JSON document)
 *   - stderr  is the diagnostics stream (tool calls, reminders, summary).
 *               Always plaintext + ANSI; never JSON.
 *   - exit codes are owned by the run command, not the formatter.
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { TaskRunSummary } from "../../task/task-loop.js";

export interface Formatter {
  readonly emitter: Emitter;
  onTaskStarted?(taskId: number): void;
  onSummary(summary: TaskRunSummary): void;
  onError(err: unknown): void;
}

export type FormatName = "text" | "jsonl" | "json";
