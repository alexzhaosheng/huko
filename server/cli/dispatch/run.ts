/**
 * server/cli/dispatch/run.ts
 *
 * `huko [flags] <prompt>` — argv parser + handoff to runCommand.
 *
 * Protocol:
 *
 *   - Walk argv left-to-right. Initial mode: `flags`.
 *   - Each token starting with `-` while in flag mode is interpreted as
 *     a recognised flag. Unrecognised flags are a parse error.
 *   - The first non-flag (bare positional) token switches the parser
 *     to `prompt` mode. That token AND every subsequent token become
 *     prompt content, verbatim — including things that look like flags.
 *   - The explicit `--` token also switches to prompt mode but is NOT
 *     itself included. Use it when the prompt's first word begins with
 *     `-` (e.g. `huko -- -3 + 5 ?` or `huko -- --metric correctness`).
 *
 * Why this shape:
 *   - Most invocations are bare prompts (`huko fix the bug`). No
 *     ceremony, no sentinel.
 *   - Flag-modified prompts work without `--`: `huko --new fix it`.
 *   - The `--` sentinel survives as the escape hatch for prompts that
 *     would otherwise look like flags.
 *   - After the first positional, NO flag re-parsing — so prompts that
 *     casually mention `--no-interaction` or `--force` aren't ambiguous.
 *
 * Examples:
 *   huko fix the bug                        # OK — prompt: "fix the bug"
 *   huko --new --title=X fix the bug        # OK — flags + prompt
 *   huko --new -- --metric correctness      # OK — explicit sentinel
 *   huko -- -3 + 5 = ?                      # OK — prompt starts with `-`
 *   huko --unknown-flag foo                 # ERROR — unknown flag
 *   huko --new                              # ERROR — no prompt
 *   huko --                                 # ERROR — empty prompt
 *
 * Returns the exit code from `runCommand` (0..5). On parse error the
 * dispatcher writes a diagnostic and throws `CliExitError` via usage().
 */

import { runCommand, type RunArgs } from "../commands/run.js";
import type { FormatName } from "../formatters/index.js";
import { usage } from "./shared.js";

// ─── Pure parser ────────────────────────────────────────────────────────────

/**
 * Parse a huko argv into either a fully-typed RunArgs, a help request,
 * or an error message. Pure function — no I/O, no process exits — so
 * tests can exercise every branch deterministically.
 */
export type ParseResult =
  | { kind: "ok"; args: RunArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseRunArgs(rest: string[]): ParseResult {
  let title: string | undefined;
  let ephemeral = false;
  let newSession = false;
  let sessionId: number | undefined;
  // Default interactive=true unless HUKO_NON_INTERACTIVE is set.
  // CLI flag overrides env. The flag exposes the LLM to a smaller
  // tool surface (no `message(type=ask)`) so it doesn't try to ask.
  let interactive = process.env["HUKO_NON_INTERACTIVE"] !== "1";
  let showTokens = false;
  let mode: "lean" | undefined;
  let verbose: boolean | undefined;
  let chat = false;
  let format: FormatName = "text";

  // Phase 1: parse flags until first bare positional OR `--` sentinel.
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;

    if (arg === "--") {
      // Explicit sentinel — switch to prompt mode, don't include this token.
      i++;
      break;
    }
    if (!arg.startsWith("-")) {
      // First bare positional — this IS prompt start. Don't increment;
      // prompt collection below will pick it up.
      break;
    }

    if (arg === "-h" || arg === "--help") return { kind: "help" };

    if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      i++;
      continue;
    }
    if (arg === "--memory") {
      ephemeral = true;
      i++;
      continue;
    }
    if (arg === "--new") {
      newSession = true;
      i++;
      continue;
    }
    if (arg === "--no-interaction" || arg === "-y") {
      interactive = false;
      i++;
      continue;
    }
    if (arg === "--show-tokens") {
      showTokens = true;
      i++;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      i++;
      continue;
    }
    if (arg === "--quiet") {
      verbose = false;
      i++;
      continue;
    }
    if (arg === "--chat") {
      chat = true;
      i++;
      continue;
    }
    if (arg === "--lean") {
      mode = "lean";
      i++;
      continue;
    }
    if (arg.startsWith("--session=")) {
      const raw = arg.slice("--session=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { kind: "error", message: `huko: invalid --session value: ${raw}\n` };
      }
      sessionId = n;
      i++;
      continue;
    }
    if (arg === "--json") {
      format = "json";
      i++;
      continue;
    }
    if (arg === "--jsonl") {
      format = "jsonl";
      i++;
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (v !== "text" && v !== "jsonl" && v !== "json") {
        return { kind: "error", message: `huko: invalid --format value: ${v}\n` };
      }
      format = v;
      i++;
      continue;
    }

    // Unknown flag. Note that things like `-3` (numbers) end up here
    // because they start with `-` and don't match any known flag.
    // Operator can use `--` sentinel: `huko -- -3 + 5`.
    return {
      kind: "error",
      message:
        `huko: unknown flag: ${arg}\n` +
        (arg.match(/^-\d/)
          ? "       (use `--` if your prompt starts with `-`: `huko -- " + arg + " ...`)\n"
          : ""),
    };
  }

  // Phase 2: everything from `i` onward is prompt content, verbatim.
  const promptTokens = rest.slice(i);

  // Mutual exclusion check.
  if (newSession && sessionId !== undefined) {
    return { kind: "error", message: "huko: --new and --session=<id> are mutually exclusive\n" };
  }

  // Empty prompts are no longer a parser-level error: the caller
  // (runCommand) decides at runtime whether to read stdin, drop into
  // chat REPL, or surface "prompt required". This keeps the parser
  // pure (no isTTY probing) while letting chat mode and stdin-piped
  // mode both pass through with `prompt = ""`.
  const prompt = promptTokens.join(" ").trim();

  return {
    kind: "ok",
    args: {
      prompt,
      format,
      ...(title !== undefined ? { title } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(newSession ? { newSession: true } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(interactive ? {} : { interactive: false }),
      ...(showTokens ? { showTokens: true } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(verbose !== undefined ? { verbose } : {}),
      ...(chat ? { chat: true } : {}),
    },
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function dispatchRun(rest: string[]): Promise<number> {
  const result = parseRunArgs(rest);
  if (result.kind === "help") usage(0);
  if (result.kind === "error") {
    process.stderr.write(result.message);
    usage();
  }
  return await runCommand(result.args);
}
