/**
 * server/cli/formatters/text.ts
 *
 * Default text formatter — ANSI-coloured, human-readable.
 *
 *   stdout: the assistant's final answer (streamed token-by-token).
 *           Pure plaintext so `huko run "..." > out.txt` captures only
 *           the answer, not the diagnostics.
 *   stderr: everything else — tool calls, tool results, reminders,
 *           thinking deltas (dim), final summary.
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { Formatter } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export function makeTextFormatter(): Formatter {
  let assistantStreaming = false;
  const printedToolCallsFor = new Set<number>();

  const emitter: Emitter = {
    emit(event) {
      switch (event.type) {
        case "user_message":
          // No echo — the user typed it themselves.
          break;

        case "assistant_started":
          assistantStreaming = true;
          break;

        case "assistant_content_delta":
          process.stdout.write(event.delta);
          break;

        case "assistant_thinking_delta":
          // Thinking is diagnostic-ish; dim, on stderr.
          process.stderr.write(dim(event.delta));
          break;

        case "assistant_complete":
          if (assistantStreaming) {
            process.stdout.write("\n");
            assistantStreaming = false;
          }
          if (event.toolCalls && event.toolCalls.length > 0 && !printedToolCallsFor.has(event.entryId)) {
            printedToolCallsFor.add(event.entryId);
            for (const c of event.toolCalls) {
              process.stderr.write(
                dim(`  → ${c.name}(${JSON.stringify(c.arguments)})`) + "\n",
              );
            }
          }
          break;

        case "tool_result": {
          const preview =
            event.content.length > 200 ? event.content.slice(0, 200) + "…" : event.content;
          if (event.error) {
            process.stderr.write(red(`  ← ${event.toolName}: error: ${event.error}`) + "\n");
          } else {
            process.stderr.write(yellow(`  ← ${event.toolName}: ${preview}`) + "\n");
          }
          break;
        }

        case "system_reminder":
          process.stderr.write(magenta(`[reminder] ${event.content}`) + "\n");
          break;

        case "system_notice":
          process.stderr.write(red(`[notice/${event.severity}] ${event.content}`) + "\n");
          break;

        case "orphan_recovered": {
          // Yellow warning — previous crash detected and stitched up.
          // Not an error (data is healed), but worth flagging so the
          // user notices it happened.
          const tail =
            event.danglingToolCount > 0
              ? ` (${event.danglingToolCount} synthetic tool_result(s) injected for pairing)`
              : "";
          process.stderr.write(
            yellow(
              `[orphan recovered] task #${event.taskId} (${event.sessionType} session #${event.sessionId}): ${event.reason}${tail}`,
            ) + "\n",
          );
          break;
        }

        case "task_terminated":
        case "task_error":
          // Handled in onSummary / onError.
          break;
      }
    },
  };

  return {
    emitter,
    onTaskStarted(_taskId) {
      // Could write a tiny "thinking..." indicator; skip for v1.
    },
    onSummary(summary) {
      process.stderr.write(
        dim(
          `\n[${summary.status}] ${summary.totalTokens} tokens · ${summary.iterationCount} iter · ${summary.toolCallCount} tools · ${summary.elapsedMs}ms`,
        ) + "\n",
      );
    },
    onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(red(`\n[error] ${msg}`) + "\n");
    },
  };
}
