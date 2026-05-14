/**
 * server/cli/commands/run-ask.ts
 *
 * Bridge between `ask_user` events (emitted by the orchestrator when
 * the LLM calls `message(type=ask)`) and the user's terminal.
 *
 * Wires in via `orchestrator.onAskUser(handler)` — a first-class
 * subscription on the orchestrator, NOT by monkey-patching the
 * formatter's emitter. Ordering is therefore structural: the
 * orchestrator pushes the event through the SessionContext emitter
 * first (so the formatter renders the question), then notifies all
 * subscribers, which is when this handler opens its prompt.
 *
 * No "must attach before bootstrap" rule, no late-bound
 * `getOrchestrator` closure — the orchestrator already exists at
 * subscription time.
 *
 * Format-aware: in text mode the user sees a coloured menu (built via
 * `prompts.select`) or a free-form prompt. In jsonl / json modes we
 * do NOT prompt — controllers (daemon / future tooling) consume the
 * ask_user event from stdout and call `respondToAsk` themselves.
 */

import type { TaskOrchestrator } from "../../services/index.js";
import type { AskUserEvent } from "../../../shared/events.js";
import { dim, red, yellow } from "../colors.js";
import {
  PromptCancelled,
  openPrompter,
  type Prompter,
} from "./prompts.js";

export type InstallAskHandlerOptions = {
  orchestrator: TaskOrchestrator;
  format: "text" | "jsonl" | "json";
  /**
   * Caller-supplied Prompter to share. Required for chat mode, where
   * the REPL already owns a Prompter on stdin and a second one would
   * bind a competing readline interface — producing duplicate echo
   * ("llm" → "llllmm") and stealing lines into the REPL's queue
   * (apparent "agent self-starts a task on its own input").
   *
   * When omitted (one-shot `huko -- ...` calls), this handler lazily
   * opens its own Prompter — that's fine because in one-shot mode no
   * other component is reading stdin concurrently.
   */
  prompter?: Prompter;
};

export type AskHandlerHandle = {
  /** Unsubscribe + close any open prompter. Idempotent. */
  close(): void;
};

export function installAskHandler(
  opts: InstallAskHandlerOptions,
): AskHandlerHandle {
  // Distinguish "we own this Prompter, we close it" from "caller owns
  // this Prompter, we don't touch its lifecycle". Closing a Prompter we
  // don't own would yank stdin out from under the caller mid-session.
  let ownedPrompter: Prompter | null = null;
  let closed = false;

  function ensurePrompter(): Prompter {
    if (opts.prompter) return opts.prompter;
    if (!ownedPrompter) ownedPrompter = openPrompter();
    return ownedPrompter;
  }

  async function handle(event: AskUserEvent): Promise<void> {
    if (closed) return;

    if (opts.format !== "text") {
      // Tooling mode: don't prompt. Surface that we saw an ask but
      // can't satisfy it from the CLI in this format. A daemon-style
      // controller would consume the jsonl event and call back via
      // respondToAsk itself.
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
        opts.orchestrator.respondToAsk(event.toolCallId, {
          content: "(user cancelled the prompt)",
        });
        return;
      }
      process.stderr.write(
        red(`\nhuko: ask failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr"),
      );
      opts.orchestrator.respondToAsk(event.toolCallId, {
        content: `(prompt error: ${err instanceof Error ? err.message : String(err)})`,
      });
      return;
    }

    const ok = opts.orchestrator.respondToAsk(event.toolCallId, { content: replyText });
    if (!ok) {
      process.stderr.write(
        yellow(
          `\nhuko: respondToAsk(${event.toolCallId}) had no waiter — reply discarded\n`,
          "stderr",
        ),
      );
    }
  }

  // Subscribe. The orchestrator notifies us AFTER the formatter has
  // rendered the question, so the prompt appears below the question
  // in the user's terminal.
  const unsubscribe = opts.orchestrator.onAskUser((event) => {
    // Detach: don't await; the orchestrator keeps flowing other events
    // through while we wait for input. Errors caught inside handle().
    void handle(event);
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      // Only close the Prompter if WE owned it. A caller-supplied one
      // stays alive for the caller to close at its own teardown.
      if (ownedPrompter) {
        ownedPrompter.close();
        ownedPrompter = null;
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
