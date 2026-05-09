#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point — and the **single** `process.exit()` site
 * in the entire CLI. Everything else returns an exit code or throws
 * `CliExitError`. That way commands are testable, embeddable in a
 * future REPL or daemon, and composable.
 *
 * This file is deliberately small. Its only job is:
 *   1. Read argv
 *   2. Find the right per-resource dispatcher in `dispatch/`
 *   3. Hand off and forward the exit code
 *
 * Argv parsing for each resource lives next to that resource in
 * `server/cli/dispatch/<resource>.ts`. Help text + shared format-flag
 * parsing lives in `server/cli/dispatch/shared.ts`. Per-resource
 * command bodies (DB ops, etc.) live in `server/cli/commands/<resource>.ts`.
 */

import { dispatchConfig } from "./dispatch/config.js";
import { dispatchKeys } from "./dispatch/keys.js";
import { dispatchModel } from "./dispatch/model.js";
import { dispatchProvider } from "./dispatch/provider.js";
import { dispatchRun } from "./dispatch/run.js";
import { dispatchSessions } from "./dispatch/sessions.js";
import { CliExitError, usage } from "./dispatch/shared.js";

type Dispatcher = (rest: string[]) => Promise<number>;

const DISPATCH: Record<string, Dispatcher> = {
  run: dispatchRun,
  sessions: dispatchSessions,
  provider: dispatchProvider,
  model: dispatchModel,
  keys: dispatchKeys,
  config: dispatchConfig,
};

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage(0);
    const head = argv[0]!;
    if (head === "-h" || head === "--help") usage(0);

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
