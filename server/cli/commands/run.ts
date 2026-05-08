/**
 * server/cli/commands/run.ts
 *
 * `huko run "..."` — one-shot mode.
 *
 * Flow:
 *   1. Build formatter for chosen output format
 *   2. Bootstrap orchestrator (SqlitePersistence + migrations)
 *   3. Verify a default model is configured
 *   4. Create an ephemeral chat session
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
};

export async function runCommand(args: RunArgs): Promise<void> {
  const formatter = makeFormatter(args.format);
  const ctx = bootstrap(formatter);

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

  // SIGINT during run → stop the task (graceful) instead of yanking the process.
  let stopRequested = false;
  const onSigint = (): void => {
    if (stopRequested) {
      // Second Ctrl+C → exit hard.
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
    const sessionId = await ctx.orchestrator.createChatSession(
      `cli ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    );
    const result = await ctx.orchestrator.sendUserMessage({
      chatSessionId: sessionId,
      content: args.prompt,
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
