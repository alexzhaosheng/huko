/**
 * server/cli/commands/chat.ts
 *
 * `huko --chat` — interactive REPL. Reads prompts from stdin in a loop,
 * runs each as a regular agent turn, and continues until the operator
 * exits.
 *
 * What's shared with one-shot `runCommand`:
 *   - per-cwd lock acquisition + release
 *   - SIGINT handling (Ctrl+C stops current task; double-Ctrl+C forces exit)
 *   - bootstrap (orchestrator + persistence + config)
 *   - formatter + ask handler + decision handler (attached once for the
 *     life of the REPL)
 *
 * What's different:
 *   - Bootstrap + handlers fire ONCE; turns are loops, not single-shot.
 *   - Session resolution: first turn honours --new / --session=/active;
 *     subsequent turns continue the chosen session unless `/new` slash
 *     command fires.
 *   - Exit paths: Ctrl+D (EOF), `/exit`, `/quit`. Ctrl+C stops the
 *     current task only (consistent with one-shot huko); a second
 *     consecutive Ctrl+C forces process exit (also consistent).
 *
 * Slash commands (v1, minimal):
 *   /exit  /quit       leave the REPL cleanly
 *   /new                start a fresh session, switch active to it
 *   /session            print current session id + title
 *   /help               list slash commands
 */

import type { TaskRunSummary } from "../../task/task-loop.js";
import { bootstrap } from "../bootstrap.js";
import { attachAskHandler } from "./run-ask.js";
import { attachDecisionHandler } from "./run-decision.js";
import { makeFormatter, type FormatName, type Formatter } from "../formatters/index.js";
import {
  acquireProjectLock,
  releaseAllProjectLocks,
  type ProjectLock,
} from "../lock.js";
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../state.js";
import { getConfig } from "../../config/index.js";
import { openPrompter, PromptCancelled, type Prompter } from "./prompts.js";
import { bold, cyan, dim, green, red, yellow } from "../colors.js";
import { formatTokenBreakdown } from "./run.js";
import type { RunArgs } from "./run.js";

// ─── Public entry ────────────────────────────────────────────────────────────

export async function chatCommand(args: RunArgs): Promise<number> {
  const cwd = process.cwd();

  // Lock: held for the entire REPL session, same semantics as a single
  // long-running `huko` invocation. Prevents concurrent huko in the
  // same cwd from sharing the session DB.
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
        process.stderr.write(`huko: waiting for ${who} in ${cwd} ...\n`);
      },
    });
    if (result.kind === "timeout") {
      process.stderr.write(
        `huko: another huko process is busy in ${cwd}. Try again in a moment.\n`,
      );
      return 5;
    }
    lock = result.lock;
  }

  // Formatter (same plumbing as run.ts). getConfig() self-loads.
  const effectiveVerbose: boolean = args.verbose ?? getConfig().cli.verbose;
  const formatter = makeFormatter(args.format, { verbose: effectiveVerbose });

  // SIGINT handling: first → stop current task; second consecutive →
  // force exit. Same semantics as one-shot huko.
  let stopRequested = false;
  const runtime = {
    activeTaskId: null as number | null,
    stopActive(): void {
      if (this.activeTaskId !== null && ctx !== null) {
        ctx.orchestrator.stop(this.activeTaskId);
      }
    },
  };
  const onSigint = (): void => {
    if (stopRequested) {
      process.stderr.write("\nhuko: forced exit\n");
      releaseAllProjectLocks();
      process.exit(130);
    }
    stopRequested = true;
    if (runtime.activeTaskId !== null) {
      process.stderr.write(
        "\nhuko: stopping (Ctrl+C again to force exit)\n",
      );
      runtime.stopActive();
    } else {
      process.stderr.write(
        "\nhuko: nothing to stop. Type /exit, /quit, or press Ctrl+D to leave.\n",
      );
    }
  };
  process.on("SIGINT", onSigint);

  let ctx: Awaited<ReturnType<typeof bootstrap>> | null = null;
  let prompter: Prompter | null = null;
  let askHandle: ReturnType<typeof attachAskHandler> | null = null;
  let decisionHandle: ReturnType<typeof attachDecisionHandler> | null = null;
  let exitCode = 0;

  // Attach handlers BEFORE bootstrap (same reasoning as run.ts).
  askHandle = attachAskHandler({
    formatter,
    format: args.format === "text" ? "text" : args.format === "json" ? "json" : "jsonl",
    getOrchestrator: () => ctx?.orchestrator ?? null,
  });
  decisionHandle = attachDecisionHandler({
    formatter,
    format: args.format === "text" ? "text" : args.format === "json" ? "json" : "jsonl",
    getOrchestrator: () => ctx?.orchestrator ?? null,
  });

  try {
    ctx = await bootstrap(formatter, {
      ...(args.ephemeral ? { ephemeral: true } : {}),
    });

    const model = ctx.infra.currentModel;
    if (model === null) {
      const cp = ctx.infra.currentProvider;
      const isFreshInstall = cp === null && ctx.infra.currentProviderSource === null;
      if (isFreshInstall) {
        process.stderr.write(
          `huko: no provider configured yet.\n` +
            `  Run the interactive setup wizard:\n` +
            `      huko setup\n`,
        );
      } else {
        process.stderr.write(`huko: no usable current model.  Run \`huko setup\`.\n`);
      }
      return 3;
    }

    // ── Resolve initial session ──────────────────────────────────────────
    // First turn honours --new / --session=/active per existing rules.
    // After that, the session persists across turns.
    let chatSessionId = await resolveInitialSession(args, ctx, cwd);

    printBanner(ctx, model, chatSessionId);

    // ── Optional initial prompt from the CLI ──────────────────────────────
    // `huko --chat "fix the bug"` runs the first turn before prompting.
    if (args.prompt.length > 0) {
      stopRequested = false;
      const summary = await runOneTurn(
        ctx,
        runtime,
        formatter,
        args.prompt,
        chatSessionId,
      );
      printTurnFooter(formatter, args, summary);
    }

    // ── REPL loop ─────────────────────────────────────────────────────────
    prompter = openPrompter();
    while (true) {
      let line: string;
      try {
        // Render our own `> ` cursor — bypass Prompter's wizard-style
        // "Question: " suffix by passing an empty question.
        process.stderr.write(bold("> ", "stderr"));
        line = await prompter.prompt("");
      } catch (err) {
        // Ctrl+D / Ctrl+C close the readline interface → PromptCancelled.
        if (err instanceof PromptCancelled) {
          process.stderr.write("\n");
          break;
        }
        process.stderr.write(`\nhuko: input error: ${describe(err)}\n`);
        continue;
      }

      const trimmed = line.trim();
      if (trimmed === "") continue;

      // Slash commands
      if (trimmed.startsWith("/")) {
        const action = await handleSlashCommand(trimmed, ctx, chatSessionId, cwd);
        if (action.kind === "exit") break;
        if (action.kind === "switched_session") {
          chatSessionId = action.newSessionId;
        }
        continue;
      }

      // Reset stopRequested when starting a new turn — Ctrl+C from a
      // previous turn shouldn't carry over into the next.
      stopRequested = false;

      const summary = await runOneTurn(ctx, runtime, formatter, trimmed, chatSessionId);
      printTurnFooter(formatter, args, summary);
    }

    process.stderr.write(green("huko: bye", "stderr") + "\n");
  } catch (err) {
    formatter.onError(err);
    exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
    if (prompter) prompter.close();
    askHandle?.close();
    decisionHandle?.close();
    if (ctx) ctx.shutdown();
    if (lock) lock.release();
  }

  return exitCode;
}

// ─── Internals ───────────────────────────────────────────────────────────────

type Runtime = { activeTaskId: number | null };
type BootstrapCtx = Awaited<ReturnType<typeof bootstrap>>;

async function resolveInitialSession(
  args: RunArgs,
  ctx: BootstrapCtx,
  cwd: string,
): Promise<number> {
  if (args.ephemeral) {
    const title = args.title ?? `chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    return await ctx.orchestrator.createChatSession(title);
  }
  if (args.sessionId !== undefined) {
    const exists = await ctx.session.sessions.get(args.sessionId);
    if (!exists) {
      throw new Error(`huko: session ${args.sessionId} not found`);
    }
    return args.sessionId;
  }
  if (args.newSession) {
    const title = args.title ?? `chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const id = await ctx.orchestrator.createChatSession(title);
    setActiveSessionId(cwd, id);
    return id;
  }
  const existing = getActiveSessionId(cwd);
  if (existing !== null) {
    const row = await ctx.session.sessions.get(existing);
    if (row) return existing;
  }
  // No active or active is dangling → create one
  const title = args.title ?? `chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const id = await ctx.orchestrator.createChatSession(title);
  setActiveSessionId(cwd, id);
  return id;
}

async function runOneTurn(
  ctx: BootstrapCtx,
  runtime: Runtime,
  formatter: Formatter,
  prompt: string,
  chatSessionId: number,
): Promise<TaskRunSummary | null> {
  try {
    const effectiveMode: "lean" | "full" = getConfig().mode;
    const lean = effectiveMode === "lean";
    const result = await ctx.orchestrator.sendUserMessage({
      chatSessionId,
      content: prompt,
      model: ctx.infra.currentModel!,
      ...(lean ? { lean: true } : {}),
    });
    runtime.activeTaskId = result.taskId;
    formatter.onTaskStarted?.(result.taskId);
    const summary = await result.completion;
    formatter.onSummary(summary);
    runtime.activeTaskId = null;
    return summary;
  } catch (err) {
    formatter.onError(err);
    runtime.activeTaskId = null;
    return null;
  }
}

function printTurnFooter(
  formatter: Formatter,
  args: RunArgs,
  summary: TaskRunSummary | null,
): void {
  if (summary && args.showTokens) {
    process.stderr.write(formatTokenBreakdown(summary) + "\n");
  }
  // Empty line between turns for readability
  process.stderr.write("\n");
}

// ─── Slash commands ──────────────────────────────────────────────────────────

type SlashAction =
  | { kind: "continue" }
  | { kind: "exit" }
  | { kind: "switched_session"; newSessionId: number };

async function handleSlashCommand(
  line: string,
  ctx: BootstrapCtx,
  currentSessionId: number,
  cwd: string,
): Promise<SlashAction> {
  const cmd = line.trim();
  switch (cmd) {
    case "/exit":
    case "/quit":
      return { kind: "exit" };

    case "/help":
      process.stderr.write(
        bold("Slash commands:", "stderr") + "\n" +
          dim("  /exit, /quit    leave the REPL\n", "stderr") +
          dim("  /new            start a new chat session (switches active)\n", "stderr") +
          dim("  /session        show current session id + title\n", "stderr") +
          dim("  /help           this list\n", "stderr"),
      );
      return { kind: "continue" };

    case "/session": {
      const row = await ctx.session.sessions.get(currentSessionId);
      if (!row) {
        process.stderr.write(red(`session ${currentSessionId} not found in DB?\n`, "stderr"));
      } else {
        process.stderr.write(
          `session ${cyan(String(row.id), "stderr")}  ` +
            (row.title ? `"${row.title}"` : dim("(untitled)", "stderr")) +
            "\n",
        );
      }
      return { kind: "continue" };
    }

    case "/new": {
      const title = `chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const id = await ctx.orchestrator.createChatSession(title);
      setActiveSessionId(cwd, id);
      process.stderr.write(green(`new session ${id} (active for ${cwd})`, "stderr") + "\n");
      return { kind: "switched_session", newSessionId: id };
    }

    default:
      process.stderr.write(
        yellow(`unknown slash command: ${cmd}. Type /help for the list.\n`, "stderr"),
      );
      return { kind: "continue" };
  }
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function printBanner(
  ctx: BootstrapCtx,
  model: NonNullable<typeof ctx.infra.currentModel>,
  sessionId: number,
): void {
  process.stderr.write(
    bold("huko", "stderr") + " · " +
      dim(`model: ${model.providerName}/${model.modelId}`, "stderr") +
      " · " +
      dim(`session: ${sessionId}`, "stderr") +
      "\n",
  );
  process.stderr.write(
    dim("Type your message. /help for commands, /exit or Ctrl+D to leave.", "stderr") + "\n\n",
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
