/**
 * server/cli/dispatch/run.ts
 *
 * `huko run [flags] -- <prompt>` — argv parser + handoff to runCommand.
 *
 * Protocol (strict, no fallback):
 *
 *   - Everything BEFORE `--` is flags. Flags can appear in any order.
 *     Any positional (non-`--*` word) before `--` is an error.
 *   - The `--` token is required when there's a prompt — it's the
 *     "end of options" sentinel from POSIX, safe across bash/zsh/PowerShell.
 *   - Everything AFTER `--` is the prompt, verbatim. No flag re-parsing,
 *     no special handling of `-`/`--` words inside. Words are joined
 *     with a single space (shell tokenisation already happened).
 *
 * Why this shape:
 *   - The old parser was order-sensitive in subtle ways and rejected
 *     prompts whose words started with `--` (e.g. `--metric correctness`)
 *     even though that's natural human prose. Quoting worked but felt
 *     bolted on.
 *   - Splitting on `--` gives parser a clear seam: left side is structured
 *     (flag-only, known vocabulary), right side is unstructured (free
 *     text, never parsed). No heuristic in the middle.
 *
 * Examples:
 *   huko run --new --title=X -- 检查 huko 代码 --metric 准确率   # OK
 *   huko run -- explain how --no-interaction works              # OK
 *   huko run hello                                               # ERROR
 *   huko run --new                                               # ERROR (no prompt)
 *   huko run --                                                  # ERROR (empty)
 *
 * Returns the exit code from `runCommand` (0..5). On parse error the
 * dispatcher writes a diagnostic and throws `CliExitError` via usage().
 */

import { runCommand, type RunArgs } from "../commands/run.js";
import type { FormatName } from "../formatters/index.js";
import { usage } from "./shared.js";

// ─── Pure parser ────────────────────────────────────────────────────────────

/**
 * Parse a `huko run` argv into either a fully-typed RunArgs, a help
 * request, or an error message. Pure function — no I/O, no process
 * exits — so tests can exercise every branch deterministically.
 */
export type ParseResult =
  | { kind: "ok"; args: RunArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseRunArgs(rest: string[]): ParseResult {
  // 1. Split on the sentinel.
  const sentinelIdx = rest.indexOf("--");
  const flagArgs = sentinelIdx >= 0 ? rest.slice(0, sentinelIdx) : rest;
  const promptArgs = sentinelIdx >= 0 ? rest.slice(sentinelIdx + 1) : null;

  // 2. Parse flag side. Known flag patterns ONLY — any unrecognised
  //    word (`--foo` or a bare positional) is an error.
  let title: string | undefined;
  let ephemeral = false;
  let role: string | undefined;
  let newSession = false;
  let sessionId: number | undefined;
  // Default interactive=true unless HUKO_NON_INTERACTIVE is set.
  // CLI flag overrides env. The flag exposes the LLM to a smaller
  // tool surface (no `message(type=ask)`) so it doesn't try to ask.
  let interactive = process.env["HUKO_NON_INTERACTIVE"] !== "1";
  let showTokens = false;
  let lean = false;
  let format: FormatName = "text";

  for (const arg of flagArgs) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };

    if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      continue;
    }
    if (arg === "--memory") {
      ephemeral = true;
      continue;
    }
    if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length);
      continue;
    }
    if (arg === "--new") {
      newSession = true;
      continue;
    }
    if (arg === "--no-interaction" || arg === "-y") {
      interactive = false;
      continue;
    }
    if (arg === "--show-tokens") {
      showTokens = true;
      continue;
    }
    if (arg === "--lean") {
      lean = true;
      continue;
    }
    if (arg.startsWith("--session=")) {
      const raw = arg.slice("--session=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { kind: "error", message: `huko run: invalid --session value: ${raw}\n` };
      }
      sessionId = n;
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--jsonl") {
      format = "jsonl";
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (v !== "text" && v !== "jsonl" && v !== "json") {
        return { kind: "error", message: `huko run: invalid --format value: ${v}\n` };
      }
      format = v;
      continue;
    }

    if (arg.startsWith("-")) {
      return { kind: "error", message: `huko run: unknown flag: ${arg}\n` };
    }

    // Bare positional before sentinel — the protocol forbids this.
    return {
      kind: "error",
      message:
        `huko run: positional argument "${arg}" is not allowed before \`--\`.\n` +
        `         Prompts must come after \`--\`. Example:\n` +
        `         huko run --new -- ${arg}${flagArgs.length > 1 ? " ..." : ""}\n`,
    };
  }

  // 3. Mutual exclusion checks.
  if (newSession && sessionId !== undefined) {
    return { kind: "error", message: "huko run: --new and --session=<id> are mutually exclusive\n" };
  }
  if (lean && role !== undefined) {
    return {
      kind: "error",
      message:
        "huko run: --lean and --role=<name> are mutually exclusive.\n" +
        "         Lean mode ignores roles by design — it uses a fixed minimal\n" +
        "         prompt and shell-only tool surface.\n",
    };
  }

  // 4. Validate prompt.
  if (promptArgs === null) {
    return {
      kind: "error",
      message:
        "huko run: prompt is required. Use `--` to mark the prompt start:\n" +
        "         huko run [flags] -- <your prompt here>\n",
    };
  }
  const prompt = promptArgs.join(" ").trim();
  if (prompt.length === 0) {
    return {
      kind: "error",
      message:
        "huko run: empty prompt after `--`. Provide the prompt text:\n" +
        "         huko run [flags] -- <your prompt here>\n",
    };
  }

  return {
    kind: "ok",
    args: {
      prompt,
      format,
      ...(title !== undefined ? { title } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(newSession ? { newSession: true } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(interactive ? {} : { interactive: false }),
      ...(showTokens ? { showTokens: true } : {}),
      ...(lean ? { lean: true } : {}),
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
