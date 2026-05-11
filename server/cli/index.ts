#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point — the single process.exit() site.
 *
 * Dispatch rule:
 *   - argv[0] is `-h` / `--help`                      → usage
 *   - argv[0] is a known noun (sessions, provider,    → that subcommand
 *     model, keys, config, info, setup, debug, safety)
 *   - argv[0] starts with `-` (flag) or is `--`       → prompt pipeline
 *   - argv[0] is a bare word, not a known subcommand  → error (typo'd
 *                                                       subcommand)
 *
 * The `--` sentinel is REQUIRED to send a free-form prompt. This keeps
 * "first bare word" unambiguously a subcommand selector — typo'd verbs
 * (`huko sesions list`) error out instead of being silently sent to the
 * LLM as `sesions list`. Examples:
 *
 *   huko sessions list                  → subcommand
 *   huko -- 你是谁？                     → prompt
 *   huko --new -- explain prompt cache  → flags + sentinel + prompt
 *   huko sesions list                   → ERROR: unknown subcommand
 *   huko 你是谁？                        → ERROR: unknown subcommand
 *
 * There is intentionally NO `run` verb — the prompt pipeline IS huko's
 * primary action; `--` is the dividing line between huko's argv and the
 * user's prompt content.
 */

import { dispatchConfig } from "./dispatch/config.js";
import { dispatchDebug } from "./dispatch/debug.js";
import { dispatchKeys } from "./dispatch/keys.js";
import { dispatchModel } from "./dispatch/model.js";
import { dispatchProvider } from "./dispatch/provider.js";
import { dispatchRun } from "./dispatch/run.js";
import { dispatchSessions } from "./dispatch/sessions.js";
import { dispatchInfo } from "./dispatch/info.js";
import { dispatchSetup } from "./dispatch/setup.js";
import { dispatchSafety } from "./dispatch/safety.js";
import { CliExitError, usage } from "./dispatch/shared.js";

type Dispatcher = (rest: string[]) => Promise<number>;

const DISPATCH: Record<string, Dispatcher> = {
  sessions: dispatchSessions,
  provider: dispatchProvider,
  model: dispatchModel,
  keys: dispatchKeys,
  config: dispatchConfig,
  info: dispatchInfo,
  setup: dispatchSetup,
  debug: dispatchDebug,
  safety: dispatchSafety,
};

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);

    // Bare `huko` with NO args:
    //   - stdin is a TTY (interactive shell) → show usage. The operator
    //     just typed `huko` to see what's available.
    //   - stdin is piped/redirected             → fall through to the
    //     prompt pipeline; runCommand will drain stdin and use it as
    //     the prompt (`echo "hi" | huko`, `huko < prompt.txt`).
    if (argv.length === 0) {
      if (process.stdin.isTTY) usage(0);
      return await dispatchRun([]);
    }

    const head = argv[0]!;
    if (head === "-h" || head === "--help") usage(0);

    // Known subcommand verb? Route there.
    const handler = DISPATCH[head];
    if (handler) {
      return await handler(argv.slice(1));
    }

    // Bare word that ISN'T a known subcommand → typo'd verb. Catch it
    // here instead of silently treating it as the start of a prompt:
    // the design contract is "subcommand goes first, prompt goes after
    // `--`", which keeps the two namespaces from colliding as the
    // subcommand surface grows.
    if (!head.startsWith("-")) {
      process.stderr.write(
        `huko: unknown subcommand: ${head}\n` +
          `       Run \`huko --help\` to see all subcommands.\n` +
          `       To send this as a prompt to the agent: huko -- ${argv.join(" ")}\n`,
      );
      return 3;
    }

    // Flags or `--` sentinel → prompt pipeline. parseRunArgs enforces
    // the same rule downstream (no bare positional after flags either).
    return await dispatchRun(argv);
  } catch (err) {
    if (err instanceof CliExitError) return err.code;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: fatal: ${msg}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
