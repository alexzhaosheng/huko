/**
 * server/cli/formatters/text.ts
 *
 * Default text formatter — ANSI-coloured, human-readable.
 *
 *   stdout: the assistant's final answer (streamed token-by-token).
 *           Pure plaintext so `huko run -- ... > out.txt` captures only
 *           the answer, not the diagnostics.
 *   stderr: everything else — tool calls, tool results, reminders,
 *           thinking deltas (dim), final summary.
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { Formatter } from "./types.js";
// Reuse the shared TTY-aware helpers — same colors as static CLI output,
// stays plain when stderr/stdout aren't TTYs (so `huko run > out.txt`
// captures clean text).
import { dim, magenta, red, yellow } from "../colors.js";

const dimErr = (s: string) => dim(s, "stderr");
const yellowErr = (s: string) => yellow(s, "stderr");
const magentaErr = (s: string) => magenta(s, "stderr");
const redErr = (s: string) => red(s, "stderr");

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
          process.stderr.write(dimErr(event.delta));
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
                dimErr(`  → ${c.name}(${JSON.stringify(c.arguments)})`) + "\n",
              );
            }
          }
          break;

        case "tool_result": {
          const preview =
            event.content.length > 200 ? event.content.slice(0, 200) + "…" : event.content;
          if (event.error) {
            process.stderr.write(redErr(`  ← ${event.toolName}: error: ${event.error}`) + "\n");
          } else {
            process.stderr.write(yellowErr(`  ← ${event.toolName}: ${preview}`) + "\n");
          }
          break;
        }

        case "system_reminder":
          process.stderr.write(magentaErr(`[reminder] ${event.content}`) + "\n");
          break;

        case "system_notice":
          process.stderr.write(redErr(`[notice/${event.severity}] ${event.content}`) + "\n");
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
            yellowErr(
              `[orphan recovered] task #${event.taskId} (${event.sessionType} session #${event.sessionId}): ${event.reason}${tail}`,
            ) + "\n",
          );
          break;
        }

        case "ask_user": {
          // Render a clearly-marked block so the user sees what's being
          // asked even though run-ask.ts will also pop a prompt right
          // after. The actual reading-from-stdin happens there; this
          // is just the visual.
          process.stderr.write("\n");
          process.stderr.write(magentaErr("?  ") + event.question + "\n");
          if (event.options && event.options.length > 0) {
            const tag = event.selectionType === "multiple"
              ? "(pick zero or more)"
              : "(pick one)";
            process.stderr.write(dimErr(`   ${tag}`) + "\n");
            for (let i = 0; i < event.options.length; i++) {
              process.stderr.write(dimErr(`   • ${event.options[i]!}`) + "\n");
            }
          }
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
        dimErr(
          `\n[${summary.status}] ${summary.totalTokens} tokens · ${summary.iterationCount} iter · ${summary.toolCallCount} tools · ${summary.elapsedMs}ms`,
        ) + "\n",
      );
    },
    onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(redErr(`\n[error] ${msg}`) + "\n");
    },
  };
}
