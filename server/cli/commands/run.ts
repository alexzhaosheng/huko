/**
 * server/cli/commands/run.ts
 *
 * `huko [flags] <prompt>` — append to the active session by default.
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

import type { TaskRunSummary } from "../../task/task-loop.js";
import { bootstrap } from "../bootstrap.js";
import { attachAskHandler } from "./run-ask.js";
import { attachDecisionHandler } from "./run-decision.js";
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
import { getConfig, loadConfig } from "../../config/index.js";
import { fstatSync } from "node:fs";

export type RunArgs = {
  prompt: string;
  format: FormatName;
  /** Override the session title (only used when a NEW session is created). */
  title?: string;
  /** When true, run with Memory persistences — state.json untouched, lock skipped. */
  ephemeral?: boolean;
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
  /**
   * Print a per-bucket token-usage breakdown (input / cache read /
   * cache write / output / total) after the run completes. CLI flag:
   * `--show-tokens`. Defaults to false.
   */
  showTokens?: boolean;
  /**
   * Per-call mode override.
   *   - "lean" — minimal system prompt + bash-only tool surface.
   *   - undefined — inherit whatever is set via HukoConfig.mode
   *     (`huko config set mode lean|full`, layered global → project).
   *
   * CLI flag `--lean` populates this.
   */
  mode?: "lean";
  /**
   * Per-call verbosity override for the text formatter.
   *   - true  — show tool_result content previews + system_reminder bodies
   *   - false — collapse them (matches HukoConfig.cli.verbose=false default)
   *   - undefined — inherit from HukoConfig.cli.verbose
   *
   * CLI: `--verbose` / `-v` sets true; `--quiet` forces false.
   */
  verbose?: boolean;
  /**
   * Interactive REPL mode. When true, huko reads prompts from stdin in
   * a loop until the operator exits (Ctrl+D, `/exit`, `/quit`). The
   * initial `prompt` field is optional in this mode — if non-empty,
   * it's submitted as the first turn before the REPL prompts for input.
   *
   * CLI: `--chat`.
   */
  chat?: boolean;
  /**
   * The operator passed `-` as the last argv token (`echo "..." | huko -`).
   * runCommand drains stdin and uses it as the prompt — the only path
   * besides argv (`-- ...`) and an explicit `< file` redirect that
   * sources prompt content from outside the command line.
   *
   * Without this flag, runCommand will NEVER read from a non-file stdin
   * — that's the deliberate fix for the "huko inherits a parent shell's
   * idle pipe and reads the next queued command" failure mode.
   */
  stdinPrompt?: boolean;
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

function promptRequiredHint(): void {
  process.stderr.write(
    "huko: prompt is required.\n" +
      "       Try: huko -- fix the bug in main.ts\n" +
      "       Pipe: echo '...' | huko -        (`-` = read prompt from stdin)\n" +
      "       File: huko < prompt.txt          (works without `-`)\n" +
      "       REPL: huko --chat\n",
  );
}

/**
 * Drain stdin and return its UTF-8 contents. Used only when the caller
 * has *explicit* signal that stdin should be the prompt source — either
 * the `-` argv token or a regular-file FD (`huko < prompt.txt`). For
 * pipes / sockets we never read without `-`, because there's no way to
 * tell at the syscall layer whether bytes on a pipe are intentional
 * input from the user or stale data from an inherited shell pipe (e.g.
 * the next command queued by a parent bash). See chat 2026-05-12 for
 * the failure mode this avoids.
 */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * True when FD 0 is a regular file — i.e. the operator did
 * `huko < prompt.txt`. Exported because index.ts also needs to make
 * the same TTY-vs-file-vs-pipe decision when deciding whether to
 * print usage for the bare-`huko` (no args) case.
 */
export function stdinIsRegularFile(): boolean {
  try {
    return fstatSync(0).isFile();
  } catch {
    return false;
  }
}

export async function runCommand(args: RunArgs): Promise<number> {
  if (args.newSession && args.sessionId !== undefined) {
    process.stderr.write("huko: --new and --session=<id> are mutually exclusive\n");
    return 3;
  }

  // Chat mode short-circuits to a REPL. Same plumbing internally
  // (lock, bootstrap, handlers) but loops on stdin instead of
  // exiting after one turn.
  if (args.chat) {
    const { chatCommand } = await import("./chat.js");
    return await chatCommand(args);
  }

  // Resolve prompt source. Precedence:
  //   1. argv prompt (`huko -- ...`)                         — wins
  //   2. explicit `-` token in argv (args.stdinPrompt)       — drain stdin
  //   3. empty argv + stdin is a regular file (`huko < ...`) — drain stdin
  //   4. otherwise                                           — "prompt required"
  //
  // We deliberately do NOT auto-drain stdin just because it's a pipe.
  // A pipe with bytes on it is ambiguous at the syscall layer between
  // "user piped me a prompt" and "I inherited a parent shell's pipe
  // with the next queued command in it". Requiring an explicit `-`
  // for the pipe case eliminates the ambiguity.
  let effectivePrompt = args.prompt;
  let stdinFed = false;
  if (effectivePrompt.length === 0) {
    const wantStdin = args.stdinPrompt === true || stdinIsRegularFile();
    if (!wantStdin) {
      promptRequiredHint();
      return 3;
    }
    effectivePrompt = (await readAllStdin()).trim();
    stdinFed = true;
    if (effectivePrompt.length === 0) {
      process.stderr.write("huko: stdin was empty; no prompt provided\n");
      return 3;
    }
  }
  // When prompt came from stdin, stdin is exhausted — `message(type=ask)`
  // and safety-policy prompts can't be answered, so drop interaction.
  // The operator can override by passing `--chat` instead of piping.
  const effectiveInteractive: boolean | undefined = stdinFed
    ? false
    : args.interactive;

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

  // Effective verbosity: CLI flag wins, otherwise inherit HukoConfig.cli.verbose
  // (default false). Only affects the `text` formatter; json/jsonl ignore it.
  // Bootstrap also calls loadConfig later — idempotent, so calling here first
  // is safe and lets the formatter see the on-disk verbose setting.
  loadConfig({ cwd });
  const effectiveVerbose: boolean = args.verbose ?? getConfig().cli.verbose;
  const formatter = makeFormatter(args.format, { verbose: effectiveVerbose });

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
  // Safety-policy decision events (parallel to ask_user). Only meaningful
  // in interactive runs — `--no-interaction` runs don't get the port
  // installed at the orchestrator either, so this handler stays silent.
  const decisionHandle = attachDecisionHandler({
    formatter,
    format: args.format === "text" ? "text" : args.format === "json" ? "json" : "jsonl",
    getOrchestrator: () => ctx?.orchestrator ?? null,
  });

  try {
    ctx = await bootstrap(formatter, {
      ...(args.ephemeral ? { ephemeral: true } : {}),
    });

    // Current provider + model check. Both come from the merged
    // InfraConfig (~/.huko/providers.json or <cwd>/.huko/providers.json
    // via `currentProvider` / `currentModel`). huko ships NO preselected
    // pair — a fresh install lands here until the user configures one.
    const model = ctx.infra.currentModel;
    if (model === null) {
      const cp = ctx.infra.currentProvider;
      const isFreshInstall = cp === null && ctx.infra.currentProviderSource === null;
      if (isFreshInstall) {
        process.stderr.write(
          `huko: no provider configured yet.\n` +
            `  Run the interactive setup wizard:\n` +
            `      huko setup\n` +
            `  Or do it manually:\n` +
            `      huko provider list      # see known providers\n` +
            `      huko provider current <name>\n` +
            `      huko model current <modelId>\n` +
            `      huko keys set <ref> <value>   # supply the API key\n`,
        );
      } else {
        const cpName = cp ? cp.name : "(none)";
        process.stderr.write(
          `huko: no usable current model.\n` +
            `  current provider: ${cpName} (set in: ${ctx.infra.currentProviderSource ?? "—"})\n` +
            `  current model:    (none / unresolved)\n` +
            `  Fix with:  huko provider current <name>  +  huko model current <modelId>\n` +
            `  Or re-run: huko setup\n`,
        );
      }
      return 3;
    }

    // ── Resolve target chat session ───────────────────────────────────────
    let chatSessionId: number;

    if (args.ephemeral) {
      const sessionTitle = args.title ?? deriveTitleFromPrompt(effectivePrompt);
      chatSessionId = await ctx.orchestrator.createChatSession(sessionTitle);
    } else if (args.sessionId !== undefined) {
      const exists = await ctx.session.sessions.get(args.sessionId);
      if (!exists) {
        process.stderr.write(`huko: session ${args.sessionId} not found\n`);
        return 4;
      }
      chatSessionId = args.sessionId;
    } else if (args.newSession) {
      const sessionTitle = args.title ?? deriveTitleFromPrompt(effectivePrompt);
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
        const sessionTitle = args.title ?? deriveTitleFromPrompt(effectivePrompt);
        chatSessionId = await ctx.orchestrator.createChatSession(sessionTitle);
        setActiveSessionId(cwd, chatSessionId);
        process.stderr.write(
          `huko: started session ${chatSessionId} (active for ${cwd})\n`,
        );
      }
    }

    // ── Run the LLM call ──────────────────────────────────────────────────
    // Resolve effective mode: CLI flag wins, otherwise inherit from
    // HukoConfig (layered default → global → project → env → explicit).
    // Bootstrap above already called loadConfig(), so getConfig() is hot.
    const effectiveMode: "lean" | "full" = args.mode ?? getConfig().mode;
    const lean = effectiveMode === "lean";

    const result = await ctx.orchestrator.sendUserMessage({
      chatSessionId,
      content: effectivePrompt,
      model,
      ...(effectiveInteractive === false ? { interactive: false } : {}),
      ...(lean ? { lean: true } : {}),
    });
    runtime.activeTaskId = result.taskId;
    formatter.onTaskStarted?.(result.taskId);

    const summary = await result.completion;
    formatter.onSummary(summary);
    if (args.showTokens) {
      process.stderr.write(formatTokenBreakdown(summary) + "\n");
    }
    exitCode =
      summary.status === "done" ? 0 : summary.status === "stopped" ? 2 : 1;
  } catch (err) {
    formatter.onError(err);
    exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
    askHandle.close();
    decisionHandle.close();
    if (ctx) ctx.shutdown();
    if (lock) lock.release();
  }

  return exitCode;
}

// ─── Token breakdown formatter ──────────────────────────────────────────────

/**
 * Render the token-usage breakdown shown after a `--show-tokens` run.
 *
 * Output (rows for cache read / cache write are only emitted when the
 * provider populated them):
 *
 *   Token usage:
 *     input          12,345
 *     cache read      3,456
 *     cache write       789
 *     output          1,234
 *     total          17,824
 *
 * Numbers are right-aligned to the widest value. The breakdown writes
 * to stderr so a piped `huko --json` consumer still gets clean
 * stdout JSON.
 *
 * Exported so tests can lock the format.
 */
export function formatTokenBreakdown(summary: TaskRunSummary): string {
  const rows: Array<[string, number]> = [
    ["input", summary.promptTokens],
  ];
  if (summary.cachedTokens > 0) rows.push(["cache read", summary.cachedTokens]);
  if (summary.cacheCreationTokens > 0) {
    rows.push(["cache write", summary.cacheCreationTokens]);
  }
  rows.push(["output", summary.completionTokens]);
  rows.push(["total", summary.totalTokens]);

  const fmt = (n: number) => n.toLocaleString("en-US");
  const numWidth = Math.max(...rows.map(([, n]) => fmt(n).length));
  const labelWidth = Math.max(...rows.map(([l]) => l.length));

  const lines = ["Token usage:"];
  for (const [label, n] of rows) {
    lines.push(
      `  ${label.padEnd(labelWidth, " ")}  ${fmt(n).padStart(numWidth, " ")}`,
    );
  }
  return lines.join("\n");
}
