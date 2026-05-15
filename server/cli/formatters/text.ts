/**
 * server/cli/formatters/text.ts
 *
 * Default text formatter — ANSI-coloured, human-readable.
 *
 *   stdout: the assistant's final answer (streamed token-by-token).
 *           Pure plaintext so `huko ... > out.txt` captures only
 *           the answer, not the diagnostics.
 *   stderr: everything else — tool calls, tool results, reminders,
 *           thinking deltas (dim), final summary.
 *
 * Verbosity (`{verbose: boolean}`):
 *   - false (default): tool_result is a one-liner ("← name: ok" or
 *     "← name: error: <code>"); system_reminder collapses to its reason
 *     attribute ("[reminder: compaction_done]"). Long tool-call args
 *     truncate to ~80 chars. Keeps the terminal scan-friendly when the
 *     LLM is busy reading files; the LLM still sees full content over
 *     the wire.
 *   - true: tool_result shows a 200-char preview; system_reminder body
 *     is rendered verbatim; tool-call args are full JSON.
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { Formatter } from "./types.js";
import { dim, magenta, red, yellow } from "../colors.js";
import { renderMd } from "./markdown.js";

const dimErr = (s: string) => dim(s, "stderr");
const yellowErr = (s: string) => yellow(s, "stderr");
const magentaErr = (s: string) => magenta(s, "stderr");
const redErr = (s: string) => red(s, "stderr");

export type TextFormatterOptions = {
  verbose: boolean;
  /** Render markdown to ANSI when stdout is a TTY. Default true. */
  renderMarkdown: boolean;
};

const TOOL_CALL_ARGS_MAX = 80; // chars before collapsing in non-verbose
const TOOL_RESULT_PREVIEW_MAX = 200; // chars when verbose

export function makeTextFormatter(opts: TextFormatterOptions = { verbose: false, renderMarkdown: true }): Formatter {
  const verbose = opts.verbose;
  const renderMarkdown = opts.renderMarkdown;
  let assistantStreaming = false;
  let thinkingActive = false;
  const printedToolCallsFor = new Set<number>();

  /**
   * Close out the dim thinking section with a blank line. Called when
   * we transition from thinking → content / tool calls / assistant
   * complete, so the user sees a visual break instead of the answer
   * running off the tail of the CoT mid-word.
   */
  function flushThinking(): void {
    if (!thinkingActive) return;
    process.stderr.write("\n\n");
    thinkingActive = false;
  }

  const emitter: Emitter = {
    emit(event) {
      switch (event.type) {
        case "user_message":
          // No echo — the user typed it themselves.
          break;

        case "assistant_started":
          // No-op — assistantStreaming flips on at the first real
          // content_delta, so turns that emit only thinking + a
          // message tool call don't print a stray trailing newline.
          // thinkingActive resets implicitly at the previous turn's
          // assistant_complete (which flushes).
          break;

        case "assistant_content_delta":
          // Thinking → content transition: terminate the dim CoT block
          // with a blank line before the answer starts on stdout.
          flushThinking();
          assistantStreaming = true;
          process.stdout.write(event.delta);
          break;

        case "assistant_thinking_delta":
          // Thinking is diagnostic-ish; dim, on stderr.
          thinkingActive = true;
          process.stderr.write(dimErr(event.delta));
          break;

        case "llm_progress_tick":
          // Heartbeat during silent LLM waits — emitted only when no
          // chunk has arrived for ~10s (see llm-call.ts). Renders as
          // a single dim middle-dot so pipe consumers (e.g. the bash
          // tool of a parent huko, watching for idle output) see we're
          // alive while a thinking model takes its time on time-to-
          // first-token. No newline — keeps the dots clustered.
          process.stderr.write(dimErr("·"));
          break;

        case "assistant_complete":
          // Thinking-only turn (no streamed content, just tool calls)
          // also needs a separator before the `→ tool(...)` lines, so
          // flush BEFORE the streaming-content newline check.
          flushThinking();
          if (assistantStreaming) {
            process.stdout.write("\n");
            assistantStreaming = false;
          }
          if (event.toolCalls && event.toolCalls.length > 0 && !printedToolCallsFor.has(event.entryId)) {
            printedToolCallsFor.add(event.entryId);
            for (const c of event.toolCalls) {
              // `message` is the user-facing delivery channel — render
              // its `text` as plaintext, NOT as a generic tool-call args
              // dump. result→stdout (the "answer"), info→stderr (mid-
              // task narration). The `← message: ok` ack is suppressed
              // in tool_result below since the user already saw the text.
              if (c.name === "message" && renderMessageCall(c.arguments, renderMarkdown)) continue;

              const argsStr = JSON.stringify(c.arguments);
              const collapsed =
                verbose || argsStr.length <= TOOL_CALL_ARGS_MAX
                  ? argsStr
                  : argsStr.slice(0, TOOL_CALL_ARGS_MAX - 1) + "…";
              process.stderr.write(
                dimErr(`  → ${c.name}(${collapsed})`) + "\n",
              );
            }
          }
          break;

        case "tool_result": {
          // `message` text was already rendered at assistant_complete
          // (see renderMessageCall). Suppress the redundant ack.
          if (event.toolName === "message" && !event.error) break;
          if (event.error) {
            // Errors always shown — the LLM's recovery depends on them
            // and the operator wants to notice. Verbose adds the full
            // body; quiet shows just the short error code.
            if (verbose) {
              const preview =
                event.content.length > TOOL_RESULT_PREVIEW_MAX
                  ? event.content.slice(0, TOOL_RESULT_PREVIEW_MAX) + "…"
                  : event.content;
              process.stderr.write(redErr(`  ← ${event.toolName}: error: ${preview}`) + "\n");
            } else {
              process.stderr.write(redErr(`  ← ${event.toolName}: error: ${event.error}`) + "\n");
            }
          } else if (verbose) {
            // Verbose: 200-char preview of the actual result body.
            const preview =
              event.content.length > TOOL_RESULT_PREVIEW_MAX
                ? event.content.slice(0, TOOL_RESULT_PREVIEW_MAX) + "…"
                : event.content;
            process.stderr.write(yellowErr(`  ← ${event.toolName}: ${preview}`) + "\n");
          } else {
            // Quiet: just acknowledge it ran. The LLM is the consumer
            // of the content; the operator doesn't need to see file
            // contents or `ls` output dumped to their terminal.
            process.stderr.write(yellowErr(`  ← ${event.toolName}: ok`) + "\n");
          }
          break;
        }

        case "system_reminder":
          // system_reminder is an internal kernel→LLM signal (compaction
          // digests, language-drift nudges, ...). Operators almost never
          // need to read it; the LLM is the audience. Quiet mode shows
          // only the `reason="..."` attribute as a one-liner; verbose
          // dumps the full body.
          if (verbose) {
            process.stderr.write(magentaErr(`[reminder] ${event.content}`) + "\n");
          } else {
            const reason = extractReminderReason(event.content);
            process.stderr.write(
              dimErr(`  [reminder: ${reason ?? "internal"}]`) + "\n",
            );
          }
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
      // Tail counters (always shown).
      const counters = `${summary.iterationCount} iter · ${summary.toolCallCount} tools · ${summary.elapsedMs}ms`;

      // Did the agent actually deliver a result via message(type=result)?
      // If not, the user is looking at a half-finished run — they need a
      // clear "no result delivered, you can continue from here" line so
      // they don't squint at empty stdout wondering "is that the answer?".
      //
      // Token-count omission is deliberate: a naked total misleads when
      // input / output / cache-read / cache-write all have different
      // per-token cost. `--show-tokens` shows the breakdown when wanted.
      if (summary.status === "stopped" && !summary.hasExplicitResult) {
        process.stderr.write(
          yellowErr(
            `\n[stopped] Task interrupted before the agent finished — no result delivered.`,
          ) + "\n" +
          dimErr(`          ${counters}`) + "\n" +
          dimErr(`          Send a follow-up prompt to continue from here: huko -- ...`) + "\n",
        );
      } else if (summary.status === "failed" && !summary.hasExplicitResult) {
        process.stderr.write(
          redErr(
            `\n[failed]  Task ended in error without delivering a result.`,
          ) + "\n" +
          dimErr(`          ${counters}`) + "\n",
        );
      } else {
        // Clean completion (status=done with a delivered result) — quiet
        // dim summary. Also covers the rarer stopped/failed-after-deliver
        // case, where the user already saw the answer on stdout.
        process.stderr.write(
          dimErr(`\n[${summary.status}] ${counters}`) + "\n",
        );
      }
    },
    onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(redErr(`\n[error] ${msg}`) + "\n");
    },
  };
}

/**
 * Pull `reason="..."` from a system_reminder body. The kernel formats
 * these as `<system_reminder reason="compaction_done">...</system_reminder>`
 * — we want just the reason for the quiet-mode one-liner.
 */
function extractReminderReason(content: string): string | null {
  const m = /<system_reminder\s+reason="([^"]+)"/.exec(content);
  return m ? m[1]! : null;
}

/**
 * Render a `message` tool call as user-facing prose. Returns true when
 * we recognised the shape and produced output, false otherwise (caller
 * falls back to the generic tool-call display).
 *
 *   type=result → stdout (the answer; pipe-friendly)
 *   type=info   → stderr (mid-task narration)
 *   type=ask    → not handled here; ask_user event renders the prompt
 */
function renderMessageCall(args: unknown, renderMarkdown: boolean): boolean {
  if (args === null || typeof args !== "object") return false;
  const obj = args as { type?: unknown; text?: unknown };
  const text = typeof obj.text === "string" ? obj.text : null;
  const type = typeof obj.type === "string" ? obj.type : null;
  if (text === null) return false;

  if (type === "result") {
    // Render markdown to ANSI when stdout is a TTY (terminal).
    // Piped stdout stays raw — pipe consumers get plain markdown.
    process.stdout.write((renderMarkdown ? renderMd(text) : text) + "\n");
    return true;
  }
  if (type === "info") {
    // Info messages may also contain light markdown (e.g. lists).
    process.stderr.write((renderMarkdown ? renderMd(text, { target: "stderr" }) : text) + "\n");
    return true;
  }
  return false;
}
