/**
 * server/cli/formatters/jsonl.ts
 *
 * Line-delimited JSON formatter.
 *
 *   stdout: one JSON-encoded HukoEvent per line. Pipeable into `jq`.
 *   stderr: only fatal errors (the run command's onError path).
 *
 * Filter examples:
 *   huko run --format=jsonl "..." | jq 'select(.type == "tool_result")'
 *   huko run --format=jsonl "..." | jq -r 'select(.type == "assistant_content_delta") | .delta' | tr -d '\n'
 *
 * `task_terminated` is the natural stream terminator. Run command exits
 * after that event (via the awaited completion promise).
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { Formatter } from "./types.js";

export function makeJsonlFormatter(): Formatter {
  const emitter: Emitter = {
    emit(event) {
      process.stdout.write(JSON.stringify(event) + "\n");
    },
  };

  return {
    emitter,
    onSummary(_summary) {
      // The `task_terminated` event already carries the summary — no
      // extra line needed here.
    },
    onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ type: "fatal_error", error: msg }) + "\n");
    },
  };
}
