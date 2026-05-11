#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point — the single process.exit() site.
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
import { CliExitError, usage } from "./dispatch/shared.js";

type Dispatcher = (rest: string[]) => Promise<number>;

const DISPATCH: Record<string, Dispatcher> = {
  run: dispatchRun,
  sessions: dispatchSessions,
  provider: dispatchProvider,
  model: dispatchModel,
  keys: dispatchKeys,
  config: dispatchConfig,
  info: dispatchInfo,
  setup: dispatchSetup,
  debug: dispatchDebug,
};

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage(0);
    const head = argv[0]!;
    if (head === "-h" || head === "--help") usage(0);

    // `run` is the implicit default verb: when the first token is a flag
    // or the `--` sentinel (i.e. anything starting with `-`), there's no
    // subcommand and the whole argv is `run` args. Lets users write
    // `huko -- hello` or `huko --new -- hello` without typing `run`.
    if (head.startsWith("-")) {
      return await dispatchRun(argv);
    }

    const handler = DISPATCH[head];
    if (!handler) {
      process.stderr.write(`huko: unknown command: ${head}\n`);
      usage();
    }

    return await handler(argv.slice(1));
  } catch (err) {
    if (err instanceof CliExitError) return err.code;
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: fatal: ${msg}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
