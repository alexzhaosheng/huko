/**
 * server/cli/commands/run-ask.ts
 *
 * Bridge between `ask_user` HukoEvents (emitted by the orchestrator
 * when the LLM calls `message(type=ask)`) and the user's terminal.
 *
 * What happens here:
 *   1. We monkey-patch the formatter's emit so we get to see every
 *      event AFTER it's rendered. (Render first, then prompt — the
 *      user sees the question in the formatter's coloured form before
 *      we open the prompt.)
 *   2. On `ask_user` we open a `Prompter` lazily (the wizard's
 *      readline shim from prompts.ts), prompt the user, submit the
 *      reply via `orchestrator.respondToAsk`.
 *   3. On task termination / error / shutdown, close the prompter so
 *      stdin returns to a clean state.
 *
 * `getOrchestrator` is late-bound: bootstrap constructs the
 * orchestrator AFTER this attach point in run.ts, but the closure only
 * needs it when an event arrives — by which time bootstrap is done.
 *
 * Format-aware: in text mode the user sees a coloured menu (built via
 * `prompts.select`) or a free-form prompt. In jsonl/json modes we DO
 * NOT prompt at all — those modes are for tooling, and any controlling
 * process is expected to consume `ask_user` events from stdout and
 * call `respondToAsk` itself (future daemon-style entry; today we
 * surface the pending ask via stderr and bail).
 */

import type { Emitter } from "../../engine/SessionContext.js";
import type { TaskOrchestrator } from "../../services/index.js";
import type { Formatter } from "../formatters/index.js";
import type { AskUserEvent } from "../../../shared/events.js";
import { dim, red, yellow } from "../colors.js";
import {
  PromptCancelled,
  openPrompter,
  type Prompter,
} from "./prompts.js";

export type AttachAskHandlerOptions = {
  formatter: Formatter;
  format: "text" | "jsonl" | "json";
  /** Late-bound — orchestrator isn't constructed yet at attach time. */
  getOrchestrator: () => TaskOrchestrator | null;
};

export type AskHandlerHandle = {
  /** Close any open prompter (e.g. on shutdown / SIGINT). Idempotent. */
  close(): void;
};

export function attachAskHandler(opts: AttachAskHandlerOptions): AskHandlerHandle {
  const inner: Emitter = opts.formatter.emitter;
  let prompter: Prompter | null = null;
  let closed = false;

  function ensurePrompter(): Prompter {
    if (!prompter) prompter = openPrompter();
    return prompter;
  }

  /**
   * Run the prompt → respond flow asynchronously. We DON'T await this
   * inside emit() — the formatter's emit must stay synchronous so the
   * orchestrator's other events keep flowing while we're collecting
   * the reply. Errors are reported to stderr; the orchestrator will
   * eventually time out / be cancelled by SIGINT.
   */
  async function handle(event: AskUserEvent): Promise<void> {
    if (closed) return;

    if (opts.format !== "text") {
      // Tooling mode: don't prompt. Surface that we saw an ask but
      // can't satisfy it from the CLI in this format. Future: a
      // daemon-style controller would consume the jsonl event and
      // call back via respondToAsk, but that path isn't wired yet.
      process.stderr.write(
        yellow(
          `\nhuko: pending ask in ${opts.format} format — controllers should call ` +
            `orchestrator.respondToAsk("${event.toolCallId}", ...). ` +
            `No interactive prompt rendered.\n`,
          "stderr",
        ),
      );
      return;
    }

    let replyText: string;
    try {
      const p = ensurePrompter();
      if (event.options && event.options.length > 0) {
        const selectionType = event.selectionType ?? "single";
        if (selectionType === "single") {
          // Numbered radio-style menu — prompts.select returns the
          // chosen option's value.
          const items = event.options.map((opt) => ({
            value: opt,
            label: opt,
          }));
          replyText = await p.select<string>("Your answer:", items);
        } else {
          // "multiple" — accept comma-separated indices for now.
          // Render the menu manually since prompts.select is single-pick only.
          process.stderr.write(dim("(pick zero or more, comma-separated indices)\n", "stderr"));
          for (let i = 0; i < event.options.length; i++) {
            process.stderr.write(`  ${i + 1}) ${event.options[i]!}\n`);
          }
          const raw = await p.prompt("Indices (e.g. 1,3) or empty for none");
          const picks = parseIndices(raw, event.options);
          replyText = picks.join(", ") || "(none)";
        }
      } else {
        // Free-form text reply.
        replyText = await p.prompt("Your answer");
      }
    } catch (err) {
      if (err instanceof PromptCancelled) {
        process.stderr.write(red("\nhuko: ask cancelled by user\n", "stderr"));
        // Submit a synthetic cancellation so the LLM doesn't hang.
        opts.getOrchestrator()?.respondToAsk(event.toolCallId, {
          content: "(user cancelled the prompt)",
        });
        return;
      }
      process.stderr.write(
        red(`\nhuko: ask failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr"),
      );
      opts.getOrchestrator()?.respondToAsk(event.toolCallId, {
        content: `(prompt error: ${err instanceof Error ? err.message : String(err)})`,
      });
      return;
    }

    const orch = opts.getOrchestrator();
    if (!orch) {
      process.stderr.write(red("\nhuko: orchestrator unavailable; reply discarded\n", "stderr"));
      return;
    }
    const ok = orch.respondToAsk(event.toolCallId, { content: replyText });
    if (!ok) {
      process.stderr.write(
        yellow(
          `\nhuko: respondToAsk(${event.toolCallId}) had no waiter — reply discarded\n`,
          "stderr",
        ),
      );
    }
  }

  // Wrap emit. Render through the formatter first, then schedule the
  // prompt asynchronously so the formatter's other event flow isn't
  // blocked by the user typing.
  const originalEmit = inner.emit.bind(inner);
  inner.emit = (event) => {
    originalEmit(event);
    if (event.type === "ask_user") {
      // Detach: don't await; let the orchestrator keep flowing other
      // events through. Errors caught inside handle().
      void handle(event);
    }
  };

  return {
    close() {
      if (closed) return;
      closed = true;
      if (prompter) {
        prompter.close();
        prompter = null;
      }
    },
  };
}

function parseIndices(raw: string, options: string[]): string[] {
  const out: string[] = [];
  for (const tok of raw.split(",")) {
    const n = Number(tok.trim());
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      out.push(options[n - 1]!);
    }
  }
  return out;
}
