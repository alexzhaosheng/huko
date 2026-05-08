/**
 * server/cli/commands/run.ts
 *
 * `huko run "..."` — one-shot mode.
 *
 * Flow:
 *   1. Build formatter for chosen output format
 *   2. Bootstrap orchestrator (default: SqlitePersistence;
 *      with `ephemeral: true`: MemoryPersistence seeded from SQLite)
 *   3. Verify a default model is configured
 *   4. Create a chat session (title derived from prompt unless overridden)
 *   5. Send the prompt; await completion
 *   6. Exit with status code derived from terminal task status
 *
 * Exit codes:
 *   0  — task done
 *   1  — task failed (or the run promise rejected)
 *   2  — task stopped (e.g. SIGINT)
 *   3  — usage error / no default model configured
 */

import { bootstrap } from "../bootstrap.js";
import { makeFormatter, type FormatName } from "../formatters/index.js";

export type RunArgs = {
  prompt: string;
  format: FormatName;
  /** Override the session title. When omitted, derived from the prompt. */
  title?: string;
  /** When true, run with MemoryPersistence (no DB writes for this run). */
  ephemeral?: boolean;
  /** Role name (loaded from server/roles/ etc.). Defaults to "coding". */
  role?: string;
};

/**
 * Build a sensible default chat-session title from the prompt.
 *
 * Strategy: collapse all whitespace to single spaces, trim, take the
 * first `max` characters. If we had to clip, append an ellipsis. Empty
 * / whitespace-only prompts fall back to a timestamped name so the
 * sessions list stays parseable.
 */
function deriveTitleFromPrompt(prompt: string, max: number = 40): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) {
    return `cli ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  }
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

export async function runCommand(args: RunArgs): Promise<void> {
  const formatter = makeFormatter(args.format);
  const ctx = await bootstrap(formatter, {
    ...(args.ephemeral ? { ephemeral: true } : {}),
  });

  // Default model check — without one we can't proceed.
  const defaultId = await ctx.persistence.config.getDefaultModelId();
  if (defaultId == null) {
    process.stderr.write(
      "huko: no default model configured.\n" +
        "  Run the daemon and set one via the model.* tRPC procedures, or\n" +
        "  run `npx tsx scripts/orchestrator-demo.ts` once to seed an OpenRouter setup.\n",
    );
    ctx.shutdown();
    process.exit(3);
  }

  // SIGINT during run -> stop the task (graceful) instead of yanking the process.
  let stopRequested = false;
  const onSigint = (): void => {
    if (stopRequested) {
      // Second Ctrl+C -> exit hard.
      process.stderr.write("\nhuko: forced exit\n");
      process.exit(130);
    }
    stopRequested = true;
    process.stderr.write("\nhuko: stopping (Ctrl+C again to force exit)\n");
    // We don't have the taskId until sendUserMessage returns; the live
    // tracker will pick it up below.
    runtime.stopActive();
  };
  process.on("SIGINT", onSigint);

  // Tiny helper to track current taskId so SIGINT can call orchestrator.stop.
  const runtime = {
    activeTaskId: null as number | null,
    stopActive() {
      if (this.activeTaskId !== null) {
        ctx.orchestrator.stop(this.activeTaskId);
      }
    },
  };

  let exitCode = 0;
  try {
    const sessionTitle = args.title ?? deriveTitleFromPrompt(args.prompt);
    const sessionId = await ctx.orchestrator.createChatSession(sessionTitle);
    const result = await ctx.orchestrator.sendUserMessage({
      chatSessionId: sessionId,
      content: args.prompt,
      ...(args.role !== undefined ? { role: args.role } : {}),
    });
    runtime.activeTaskId = result.taskId;
    formatter.onTaskStarted?.(result.taskId);

    const summary = await result.completion;
    formatter.onSummary(summary);
    exitCode =
      summary.status === "done" ? 0 : summary.status === "stopped" ? 2 : 1;
  } catch (err) {
    formatter.onError(err);
    exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
    ctx.shutdown();
  }

  process.exit(exitCode);
}
