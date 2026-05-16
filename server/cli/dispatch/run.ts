/**
 * server/cli/dispatch/run.ts
 *
 * `huko [flags] -- <prompt>` or `huko [flags] -` — argv parser +
 * handoff to runCommand.
 *
 * Protocol:
 *
 *   - Walk argv left-to-right. Initial mode: `flags`.
 *   - Each token starting with `-` while in flag mode is interpreted as
 *     a recognised flag. Unrecognised flags are a parse error.
 *   - The `--` sentinel switches the parser to `prompt` mode and is
 *     NOT itself included. Everything after is prompt content,
 *     verbatim — including things that look like flags.
 *   - The bare `-` token (unix convention for stdin) sets
 *     `stdinPrompt: true` and MUST be the last argv token; it is
 *     mutually exclusive with `--`.
 *   - A bare (non-flag) positional token in flag mode is a parse error.
 *     Prompt content MUST be introduced by `--` so that "first bare
 *     word" stays unambiguously a subcommand-selector slot at the
 *     index.ts level.
 *
 * Why this shape:
 *   - Subcommand surface keeps growing (sessions / info / setup /
 *     provider / model / keys / safety / config / debug / ...). Letting
 *     the prompt overload "first bare word" means typo'd verbs like
 *     `huko sesions list` get sent to the LLM as a prompt — confusing.
 *     Forcing `--` cleanly separates the two namespaces forever.
 *   - `-` for stdin is the standard unix idiom (cat, sort, diff). It
 *     replaces the old "auto-drain stdin if non-TTY" heuristic, which
 *     deadlocked when huko inherited an idle pipe (e.g. another huko's
 *     bash tool keeping stdin open with the next queued command in it).
 *     Requiring `-` makes the intent explicit; pipes are never drained
 *     by accident. (`huko < prompt.txt` still works without `-` —
 *     regular-file FDs are unambiguous.)
 *   - After `--`, NO flag re-parsing — prompts mentioning `--metric` or
 *     `--no-interaction` are passed through as prompt content.
 *   - Empty prompt + no `-` is permitted: caller (runCommand) decides
 *     at runtime — `huko < file` reads the file; `huko --chat` enters
 *     the REPL; otherwise "prompt required".
 *
 * Examples:
 *   huko -- fix the bug                     # OK — prompt: "fix the bug"
 *   huko --new --title=X -- fix the bug     # OK — flags + sentinel + prompt
 *   huko --new -- --metric correctness      # OK — `--metric` is prompt content
 *   huko -- -3 + 5 = ?                      # OK — prompt may start with `-`
 *   echo "fix bug" | huko -                 # OK — `-` = read prompt from stdin
 *   huko --new -                            # OK — flags + read stdin
 *   huko --unknown-flag                     # ERROR — unknown flag
 *   huko --new fix the bug                  # ERROR — bare positional, missing `--`
 *   huko - foo                              # ERROR — argv after `-`
 *   huko - --                               # ERROR — `-` and `--` are exclusive
 *   huko --                                 # OK   — empty prompt; runCommand decides
 *
 * Returns the exit code from `runCommand` (0..5). On parse error the
 * dispatcher writes a diagnostic and throws `CliExitError` via usage().
 */

import { runCommand, type RunArgs } from "../commands/run.js";
import type { FormatName } from "../formatters/index.js";
import { usage } from "./shared.js";
import { isLikelyPowerShell, formatPowerShellSentinelHint } from "../env-hints.js";

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
  let stdinPrompt = false;
  const enableFeatures: string[] = [];
  const disableFeatures: string[] = [];
  const skills: string[] = [];
  let noMarkdown = false;
  let compactThreshold: number | undefined;

  // Phase 1: parse flags until first bare positional, `--` sentinel,
  // or `-` (stdin marker).
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;

    if (arg === "--") {
      // Explicit sentinel — switch to prompt mode, don't include this token.
      i++;
      break;
    }
    if (arg === "-") {
      // Stdin marker — must be the last token, mutually exclusive with
      // any further argv. Caller (runCommand) will drain stdin.
      i++;
      if (i < rest.length) {
        return {
          kind: "error",
          message:
            `huko: \`-\` (stdin prompt) must be the last argument; got: ${rest.slice(i).join(" ")}\n`,
        };
      }
      stdinPrompt = true;
      break;
    }
    if (!arg.startsWith("-")) {
      // Bare positional in flag mode — under the new contract prompts
      // MUST be introduced by `--`. Without this rule, `huko --new fix
      // the bug` would be ambiguous with `huko --new sesions list`
      // (typo'd subcommand silently sent to the LLM). Tell the user
      // exactly how to spell what they likely meant.
      const tail = rest.slice(i).join(" ");
      return {
        kind: "error",
        message:
          `huko: unexpected positional argument: ${arg}\n` +
          `       Use \`--\` to separate flags from your prompt:\n` +
          `       huko ${rest.slice(0, i).join(" ")}${i > 0 ? " " : ""}-- ${tail}\n`,
      };
    }

    if (arg === "-h" || arg === "--help") return { kind: "help" };

    if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      i++;
      continue;
    }
    if (arg === "--memory" || arg === "-m") {
      ephemeral = true;
      i++;
      continue;
    }
    if (arg === "--new" || arg === "-n") {
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
    if (arg === "--chat" || arg === "-c") {
      chat = true;
      i++;
      continue;
    }
    if (arg === "--lean") {
      mode = "lean";
      i++;
      continue;
    }
    if (arg === "--no-markdown" || arg === "--no-md") {
      noMarkdown = true;
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
    if (arg.startsWith("--enable=")) {
      const name = arg.slice("--enable=".length).trim();
      if (name.length === 0) {
        return { kind: "error", message: `huko: --enable= requires a feature name\n` };
      }
      enableFeatures.push(name);
      i++;
      continue;
    }
    if (arg.startsWith("--disable=")) {
      const name = arg.slice("--disable=".length).trim();
      if (name.length === 0) {
        return { kind: "error", message: `huko: --disable= requires a feature name\n` };
      }
      disableFeatures.push(name);
      i++;
      continue;
    }
    if (arg.startsWith("--skill=")) {
      const name = arg.slice("--skill=".length).trim();
      if (name.length === 0) {
        return { kind: "error", message: `huko: --skill= requires a skill name\n` };
      }
      if (!skills.includes(name)) skills.push(name);
      i++;
      continue;
    }
    if (arg.startsWith("--compact-threshold=")) {
      const raw = arg.slice("--compact-threshold=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0.05 || n > 0.99) {
        return {
          kind: "error",
          message:
            `huko: invalid --compact-threshold value: ${raw}\n` +
            `       expected a number in [0.05, 0.99]\n`,
        };
      }
      compactThreshold = n;
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
  // (When `stdinPrompt` is true the loop already consumed the `-` and
  // forbids further argv, so promptTokens is guaranteed empty.)
  const promptTokens = rest.slice(i);

  // Mutual exclusion checks.
  if (newSession && sessionId !== undefined) {
    return { kind: "error", message: "huko: --new and --session=<id> are mutually exclusive\n" };
  }
  // Same feature name in both --enable and --disable is a typo / mistake
  // rather than a sane request. Fail loud rather than picking a winner.
  if (enableFeatures.length > 0 && disableFeatures.length > 0) {
    const conflict = enableFeatures.find((n) => disableFeatures.includes(n));
    if (conflict !== undefined) {
      return {
        kind: "error",
        message: `huko: feature "${conflict}" is both --enabled and --disabled — pick one\n`,
      };
    }
  }
  if (stdinPrompt && promptTokens.length > 0) {
    // Defensive — `-` handler already errors on this, but if a future
    // refactor reorders the loop, keep the contract enforceable here.
    return {
      kind: "error",
      message: "huko: `-` (stdin prompt) cannot be combined with an inline prompt\n",
    };
  }

  // Empty prompts are no longer a parser-level error: the caller
  // (runCommand) decides at runtime whether to read stdin (because of
  // `-` or because FD 0 is a regular file), drop into chat REPL, or
  // surface "prompt required". This keeps the parser pure (no isTTY
  // probing).
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
      ...(stdinPrompt ? { stdinPrompt: true } : {}),
      ...(enableFeatures.length > 0 ? { enableFeatures } : {}),
      ...(disableFeatures.length > 0 ? { disableFeatures } : {}),
      ...(noMarkdown ? { noMarkdown: true } : {}),
      ...(compactThreshold !== undefined ? { compactThreshold } : {}),
      ...(skills.length > 0 ? { skills } : {}),
    },
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function dispatchRun(rest: string[]): Promise<number> {
  const result = parseRunArgs(rest);
  if (result.kind === "help") usage(0);
  if (result.kind === "error") {
    let msg = result.message;
    // PowerShell's legacy argument passing silently strips `--` before
    // invoking external commands. Symptom: parser sees a bare positional
    // that was supposed to be the prompt body. When that's the error AND
    // we detect a PS env, append the three-option workaround menu. The
    // sister case (PS stripping `--` AND argv landing at the top-level
    // dispatcher's "unknown subcommand") is handled in index.ts.
    if (isLikelyPowerShell() && isStrippedSentinelSymptom(msg)) {
      msg += formatPowerShellSentinelHint();
    }
    process.stderr.write(msg);
    usage();
  }
  return await runCommand(result.args);
}

/**
 * Does this parse-error message look like the symptom of a stripped `--`
 * sentinel (PowerShell legacy mode)? Returns true for:
 *   - "unexpected positional argument"  — bare token where the parser
 *     expected a flag or sentinel, classic PS-strips-`--` outcome.
 *
 * Keeping this string-match local + narrow on purpose: the goal is "be
 * helpful when the symptom matches", not "always nag PS users".
 */
function isStrippedSentinelSymptom(message: string): boolean {
  return message.includes("unexpected positional argument");
}
