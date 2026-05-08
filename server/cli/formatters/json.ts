/**
 * server/cli/formatters/json.ts
 *
 * Single-shot JSON formatter — for shell scripts that want one
 * structured result, not a stream.
 *
 *   stdout: one JSON document at task end, with the summary + final answer.
 *   stderr: live diagnostics in plain text (so the user can see progress).
 *
 * Use case:
 *   const result = $(huko run --json "summarize this PDF")
 *   echo $result | jq '.final'
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { Formatter } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export function makeJsonFormatter(): Formatter {
  const emitter: Emitter = {
    emit(event) {
      switch (event.type) {
        case "tool_result": {
          const preview =
            event.content.length > 120 ? event.content.slice(0, 120) + "…" : event.content;
          if (event.error) {
            process.stderr.write(red(`  ← ${event.toolName}: error: ${event.error}`) + "\n");
          } else {
            process.stderr.write(yellow(`  ← ${event.toolName}: ${preview}`) + "\n");
          }
          break;
        }
        case "assistant_complete":
          if (event.toolCalls?.length) {
            for (const c of event.toolCalls) {
              process.stderr.write(
                dim(`  → ${c.name}(${JSON.stringify(c.arguments)})`) + "\n",
              );
            }
          }
          break;
        // All other events are silent in json mode — we'll synthesise
        // the final document in onSummary.
      }
    },
  };

  return {
    emitter,
    onSummary(summary) {
      const doc = {
        status: summary.status,
        final: summary.finalResult,
        hasExplicitResult: summary.hasExplicitResult,
        usage: {
          promptTokens: summary.promptTokens,
          completionTokens: summary.completionTokens,
          totalTokens: summary.totalTokens,
        },
        iterationCount: summary.iterationCount,
        toolCallCount: summary.toolCallCount,
        elapsedMs: summary.elapsedMs,
      };
      process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    },
    onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      const doc = { status: "error", error: msg };
      process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    },
  };
}
