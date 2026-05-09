/**
 * server/cli/commands/run.ts
 *
 * `huko run "..."` — append to the active session by default.
 *
 * Session selection:
 *   1. `--session=<id>`   one-off send to that session; active pointer
 *                         is NOT touched. Errors if the id doesn't exist.
 *   2. `--new`            force a fresh session and switch active to it.
 *   3. (default)          continue the cwd's active session if one
 *                         exists and is still in the DB; otherwise
 *                         create a fresh session and set it active.
 *   4. `--memory`         ephemeral mode — always a fresh in-memory
 *                         session, state.json untouched, lock skipped.
 *
 * Concurrency: persistent runs acquire a per-cwd advisory lock at
 * `<cwd>/.huko/lock` before bootstrap. This protects against:
 *   - two processes running orphan recovery in parallel (would
 *     duplicate synthetic tool_results)
 *   - two processes interleaving messages on the same active session
 *
 * 5-second wait, 30-second stale-lock threshold. `--memory` skips the
 * lock entirely (ephemeral runs are independent).
 *
 * Flow:
 *   1. Build formatter for chosen output format
 *   2. (if persistent) Acquire per-cwd lock; on timeout, exit 5
 *   3. Bootstrap orchestrator (SQLite both, or Memory both for --memory)
 *   4. Verify a default model is configured
 *   5. Resolve which chatSessionId to use
 *   6. Send the prompt; await completion
 *   7. Exit with status code derived from terminal task status
 *
 * Exit codes:
 *   0  — task done
 *   1  — task failed (or the run promise rejected)
 *   2  — task stopped (e.g. SIGINT)
 *   3  — usage error / no default model configured
 *   4  — `--session=<id>` referenced an id that doesn't exist
 *   5  — couldn't acquire per-cwd lock within timeout
 */

import { bootstrap } from "../bootstrap.js";
import { makeFormatter, type FormatName } from "../formatters/index.js";
import {
  acquireProjectLock,
  releaseAllProjectLocks,
  type ProjectLock,
} from "../lock.js";
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../state.js";

export type RunArgs = {
  prompt: string;
  format: FormatName;
  /** Override the session title (only used when a NEW session is created). */
  title?: string;
  /** When true, run with Memory persistences — state.json untouched, lock skipped. */
  ephemeral?: boolean;
  /** Role name (loaded from server/roles/ etc.). Defaults to "coding". */
  role?: string;
  /** Force a brand-new session and switch the active pointer to it. */
  newSession?: boolean;
  /** One-off send to a specific session id; active pointer untouched. */
  sessionId?: number;
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
  if (args.newSession && args.sessionId !== undefined) {
    process.stderr.write("huko run: --new and --session=<id> are mutually exclusive\n");
    process.exit(3);
  }

  const cwd = process.cwd();

  // ── Acquire per-cwd lock (skipped in --memory mode) ─────────────────────
  let lock: ProjectLock | null = null;
  if (!args.ephemeral) {
    const result = await acquireProjectLock(cwd, {
      timeoutMs: 5000,
      staleMs: 30_000,
      onWaiting: (info) => {
        const who =
          info.pid !== null
            ? `another huko process (PID ${info.pid})`
            : "another huko process";
        process.stderr.write(
          `huko: waiting for ${who} to finish in ${cwd} ...\n`,
        );
      },
    });
    if (result.kind === "timeout") {
      const who =
        result.holder.pid !== null
          ? `another huko process (PID ${result.holder.pid})`
          : "another huko process";
      process.stderr.write(
        `huko: ${who} is busy in ${cwd}. Try again in a moment, or use --memory if you don't need shared state.\n`,
      );
      process.exit(5);
    }
    lock = result.lock;
  }

  const formatter = makeFormatter(args.format);

  // From here on, anything that can throw must run under try/finally so
  // the lock + persistence connections are cleaned up.
  let exitCode = 0;
  let ctx: Awaited<ReturnType<typeof bootstrap>> | null = null;

  // SIGINT during run -> stop the task (graceful) instead of yanking the process.
  // Second Ctrl+C: hard exit but still release locks via the synchronous
  // helper (the registered process.on('exit') hook also catches it).
  let stopRequested = false;
  const onSigint = (): void => {
    if (stopRequested) {
      process.stderr.write("\nhuko: forced exit\n");
      releaseAllProjectLocks();
      process.exit(130);
    }
    stopRequested = true;
    process.stderr.write("\nhuko: stopping (Ctrl+C again to force exit)\n");
    runtime.stopActive();
  };

  // Tiny helper to track current taskId so SIGINT can call orchestrator.stop.
  const runtime = {
    activeTaskId: null as number | null,
    stopActive() {
      if (this.activeTaskId !== null && ctx !== null) {
        ctx.orchestrator.stop(this.activeTaskId);
      }
    },
  };

  process.on("SIGINT", onSigint);

  try {
    ctx = await bootstrap(formatter, {
      ...(args.ephemeral ? { ephemeral: true } : {}),
    });

    // Default model check — without one we can't proceed.
    const defaultId = await ctx.infra.config.getDefaultModelId();
    if (defaultId == null) {
      process.stderr.write(
        "huko: no default model configured.\n" +
          "  Configure one with `huko provider add ...` + `huko keys set ...` +\n" +
          "  `huko model add ... --default`, or run `npx tsx scripts/orchestrator-demo.ts`\n" +
          "  once to seed an OpenRouter setup.\n",
      );
      exitCode = 3;
      return;
    }

    // ── Resolve target chat session ───────────────────────────────────────
    let chatSessionId: number;

    if (args.ephemeral) {
      const sessionTitle = args.title ?? deriveTitleFromPrompt(args.prompt);
      chatSessionId = await ctx.orchestrator.createChatSession(sessionTitle);
    } else if (args.sessionId !== undefined) {
      const exists = await ctx.session.sessions.get(args.sessionId);
      if (!exists) {
        process.stderr.write(`huko run: session ${args.sessionId} not found\n`);
        exitCode = 4;
        return;
      }
      chatSessionId = args.sessionId;
    } else if (args.newSession) {
      const sessionTitle = args.title ?? deriveTitleFromPrompt(args.prompt);
      chatSessionId = await ctx.orchestrator.createChatSession(sessionTitle);
      setActiveSessionId(cwd, chatSessionId);
      process.stderr.write(
        `huko: started session ${chatSessionId} (active for ${cwd})\n`,
      );
    } else {
      const active = getActiveSessionId(cwd);
      let useActive = active !== null;
      if (useActive && active !== null) {
        const stillExists = await ctx.session.sessions.get(active);
        if (!stillExists) useActive = false;
      }

      if (useActive && active !== null) {
        chatSessionId = active;
      } else {
        const sessionTitle = args.title ?? deriveTitleFromPrompt(args.prompt);
        chatSessionId = await ctx.orchestrator.createChatSession(sessionTitle);
        setActiveSessionId(cwd, chatSessionId);
        process.stderr.write(
          `huko: started session ${chatSessionId} (active for ${cwd})\n`,
        );
      }
    }

    // ── Run the LLM call ──────────────────────────────────────────────────
    const result = await ctx.orchestrator.sendUserMessage({
      chatSessionId,
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
    if (ctx) ctx.shutdown();
    if (lock) lock.release();
  }

  process.exit(exitCode);
}
