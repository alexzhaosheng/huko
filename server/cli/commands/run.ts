/**
 * server/cli/commands/run.ts
 *
 * `huko run "..."` — append to the active session by default.
 *
 * Session selection:
 *   1. `--session=<id>`   one-off send to that session; active pointer
 *                         is NOT touched. Returns 4 if the id doesn't exist.
 *   2. `--new`            force a fresh session and switch active to it.
 *   3. (default)          continue the cwd's active session if one
 *                         exists and is still in the DB; otherwise
 *                         create a fresh session and set it active.
 *   4. `--memory`         ephemeral mode — always a fresh in-memory
 *                         session, state.json untouched, lock skipped.
 *
 * Concurrency: persistent runs acquire a per-cwd advisory lock at
 * `<cwd>/.huko/lock` before bootstrap. 5-second wait, 30-second stale
 * threshold; returns 5 on contention. `--memory` skips the lock.
 *
 * Returns an exit code; never calls `process.exit` directly. The single
 * `process.exit()` site lives in `server/cli/index.ts`. Second-Ctrl+C
 * is the only "kill the process now" path — it bypasses the return
 * channel because there's no further work to do anyway.
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
import { attachAskHandler } from "./run-ask.js";
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
  /** Role name (loaded from server/roles/ etc.). Defaults to "general". */
  role?: string;
  /** Force a brand-new session and switch the active pointer to it. */
  newSession?: boolean;
  /** One-off send to a specific session id; active pointer untouched. */
  sessionId?: number;
  /**
   * When false, drop `message(type=ask)` from the LLM's tool surface
   * so it can't request user input mid-task. CLI flag: `--no-interaction`
   * / `-y`. Env: `HUKO_NON_INTERACTIVE=1`. Defaults to true.
   */
  interactive?: boolean;
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

export async function runCommand(args: RunArgs): Promise<number> {
  if (args.newSession && args.sessionId !== undefined) {
    process.stderr.write("huko run: --new and --session=<id> are mutually exclusive\n");
    return 3;
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
      return 5;
    }
    lock = result.lock;
  }

  const formatter = makeFormatter(args.format);

  // From here on, anything that can throw must run under try/finally so
  // the lock + persistence connections are cleaned up.
  let exitCode = 0;
  let ctx: Awaited<ReturnType<typeof bootstrap>> | null = null;

  // SIGINT during run -> stop the task (graceful) instead of yanking the process.
  // Second Ctrl+C is the ONE remaining hard-exit path: there's no useful work
  // to do, the user wants out now. We still synchronously release locks via
  // the `process.on("exit")` hook installed in lock.ts.
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

  // Attach ask-user handler BEFORE bootstrap. The handler wraps
  // formatter.emitter (which is what bootstrap will hand to the
  // orchestrator), so every ask_user event is observed even if it
  // races against bootstrap returning. `getOrchestrator` is a
  // late-bound closure — `ctx` is set right after the bootstrap
  // line below, before any tool call could run.
  const askHandle = attachAskHandler({
    formatter,
    format: args.format === "text" ? "text" : args.format === "json" ? "json" : "jsonl",
    getOrchestrator: () => ctx?.orchestrator ?? null,
  });

  try {
    ctx = await bootstrap(formatter, {
      ...(args.ephemeral ? { ephemeral: true } : {}),
    });

    // Current provider + model check. Both come from the merged
    // InfraConfig (built-in pointers seeded by builtin-providers.ts;
    // overridable in ~/.huko/providers.json or <cwd>/.huko/providers.json
    // via `currentProvider` / `currentModel`). Built-ins point at
    // anthropic/claude-sonnet-4-6 so this branch fires only if the user
    // explicitly cleared one of them and we can't pair them up.
    const model = ctx.infra.currentModel;
    if (model === null) {
      const cp = ctx.infra.currentProvider;
      const cpName = cp ? cp.name : "(none)";
      process.stderr.write(
        `huko: no usable current model.\n` +
          `  current provider: ${cpName} (set in: ${ctx.infra.currentProviderSource ?? "—"})\n` +
          `  current model:    (none / unresolved)\n` +
          `  Fix with:  huko provider current <name>  +  huko model current <modelId>\n` +
          `  Or list: huko model list\n`,
      );
      return 3;
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
        return 4;
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
      model,
      ...(args.role !== undefined ? { role: args.role } : {}),
      ...(args.interactive === false ? { interactive: false } : {}),
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
    askHandle.close();
    if (ctx) ctx.shutdown();
    if (lock) lock.release();
  }

  return exitCode;
}
