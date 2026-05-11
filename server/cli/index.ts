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
 *   - anything else                                   → free-form prompt
 *
 * The "free-form prompt" path is the most common: `huko fix the bug`,
 * `huko --new fix the bug`, `huko -- --rare-edge-case-prompt`. The
 * prompt parser (dispatch/run.ts) walks argv left-to-right; the first
 * non-flag positional switches to prompt mode and everything after is
 * verbatim. The `--` sentinel is the escape hatch for prompts that
 * happen to start with `-`.
 *
 * There is intentionally NO `run` verb. The agent IS huko's primary
 * action — typing it would be redundant.
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
    if (argv.length === 0) usage(0);
    const head = argv[0]!;
    if (head === "-h" || head === "--help") usage(0);

    // Known subcommand verb? Route there.
    const handler = DISPATCH[head];
    if (handler) {
      return await handler(argv.slice(1));
    }

    // Otherwise — flags, bare prompts, anything else — goes to the
    // prompt pipeline. The parser handles flag-vs-positional disambiguation.
    return await dispatchRun(argv);
  } catch (err) {
    if (err instanceof CliExitError) return err.code;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: fatal: ${msg}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
