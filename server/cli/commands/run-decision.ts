/**
 * server/cli/commands/run-decision.ts
 *
 * Bridge between `decision_required` events (emitted by the
 * orchestrator when the safety-policy gate decides to PROMPT before a
 * tool call) and the user's terminal.
 *
 * Parallel to `run-ask.ts` — same subscription pattern via
 * `orchestrator.onDecision(handler)`. Different from `ask_user`
 * because:
 *   - The prompter is initiated by the TOOL PIPELINE, not the LLM.
 *   - The reply is ternary (allow / deny / always allow), not free text.
 *   - "always allow" persists the matched pattern to the global
 *     `safety.toolRules.<tool>.allow` list via
 *     `orchestrator.respondToDecision({ kind: "allow_and_remember" })`.
 *
 * Format-aware: text mode shows a coloured y/n/a select; json / jsonl
 * modes surface the event but don't prompt — controllers (daemon /
 * future tooling) consume the JSON event and call respondToDecision
 * themselves.
 */

import type { TaskOrchestrator } from "../../services/index.js";
import type { DecisionRequiredEvent } from "../../../shared/events.js";
import { bold, dim, red, yellow } from "../colors.js";
import {
  PromptCancelled,
  openPrompter,
  type Prompter,
} from "./prompts.js";

export type InstallDecisionHandlerOptions = {
  orchestrator: TaskOrchestrator;
  format: "text" | "jsonl" | "json";
  /**
   * Caller-supplied Prompter to share. See the same option on
   * installAskHandler for the rationale — chat mode MUST inject its
   * REPL Prompter here, otherwise two readline interfaces bind to
   * stdin and produce duplicate echo + line-queue collisions.
   */
  prompter?: Prompter;
};

export type DecisionHandlerHandle = {
  /** Unsubscribe + close any open prompter. Idempotent. */
  close(): void;
};

export function installDecisionHandler(
  opts: InstallDecisionHandlerOptions,
): DecisionHandlerHandle {
  // Same ownership rule as run-ask.ts: only close Prompters we created.
  let ownedPrompter: Prompter | null = null;
  let closed = false;

  function ensurePrompter(): Prompter {
    if (opts.prompter) return opts.prompter;
    if (!ownedPrompter) ownedPrompter = openPrompter();
    return ownedPrompter;
  }

  async function handle(event: DecisionRequiredEvent): Promise<void> {
    if (closed) return;

    if (opts.format !== "text") {
      // Tooling mode: surface the event, don't prompt. Controller is
      // expected to call respondToDecision via its own channel.
      process.stderr.write(
        yellow(
          `\nhuko: pending safety decision in ${opts.format} format — controllers should call ` +
            `orchestrator.respondToDecision("${event.toolCallId}", { kind: "allow"|"deny"|"allow_and_remember" }). ` +
            `No interactive prompt rendered.\n`,
          "stderr",
        ),
      );
      return;
    }

    // Render the question — tool name + matched value + reason.
    process.stderr.write("\n");
    process.stderr.write(
      bold("huko: safety prompt", "stderr") + " — " + event.reason + "\n",
    );
    process.stderr.write(
      dim(`  tool:    ${event.toolName}`, "stderr") + "\n",
    );
    if (event.matchedField && event.matchedValue !== undefined) {
      process.stderr.write(
        dim(`  ${event.matchedField}:   ${event.matchedValue}`, "stderr") + "\n",
      );
    }
    if (event.matchedPattern !== undefined) {
      process.stderr.write(
        dim(`  rule:    ${event.matchedPattern}`, "stderr") + "\n",
      );
    }

    // Build the choices. "Always allow" is only meaningful when we have
    // a concrete pattern to persist — for byDangerLevel-default prompts
    // there's nothing to remember, so we hide it.
    const items: Array<{ value: "allow" | "deny" | "allow_and_remember"; label: string; hint?: string }> = [
      { value: "allow", label: "Allow this one call" },
      { value: "deny",  label: "Deny — refuse and report to the model" },
    ];
    if (event.matchedPattern !== undefined) {
      items.push({
        value: "allow_and_remember",
        label: "Always allow",
        hint: `appends \`${event.matchedPattern}\` to global ${event.toolName}.allow rules`,
      });
    }

    let outcome: "allow" | "deny" | "allow_and_remember";
    try {
      const p = ensurePrompter();
      outcome = await p.select("Decide:", items);
    } catch (err) {
      if (err instanceof PromptCancelled) {
        process.stderr.write(red("\nhuko: decision cancelled — treating as deny\n", "stderr"));
        opts.orchestrator.respondToDecision(event.toolCallId, { kind: "deny" });
        return;
      }
      process.stderr.write(
        red(`\nhuko: decision prompt failed: ${err instanceof Error ? err.message : String(err)}\n`, "stderr"),
      );
      opts.orchestrator.respondToDecision(event.toolCallId, { kind: "deny" });
      return;
    }

    const ok = opts.orchestrator.respondToDecision(event.toolCallId, { kind: outcome });
    if (!ok) {
      process.stderr.write(
        yellow(
          `\nhuko: respondToDecision(${event.toolCallId}) had no waiter — decision discarded\n`,
          "stderr",
        ),
      );
    }
  }

  const unsubscribe = opts.orchestrator.onDecision((event) => {
    void handle(event);
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (ownedPrompter) {
        ownedPrompter.close();
        ownedPrompter = null;
      }
    },
  };
}
