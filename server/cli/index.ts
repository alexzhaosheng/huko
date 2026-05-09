#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point.
 *
 * This file is deliberately small. Its only job is:
 *   1. Read argv
 *   2. Find the right per-resource dispatcher in `dispatch/`
 *   3. Hand off
 *
 * Argv parsing for each resource lives next to that resource in
 * `server/cli/dispatch/<resource>.ts`. Help text + shared format-flag
 * parsing lives in `server/cli/dispatch/shared.ts`. Per-resource
 * command bodies (DB ops, etc.) live in `server/cli/commands/<resource>.ts`.
 *
 * Adding a new top-level resource:
 *   1. Add a file under `commands/` with the actual work
 *   2. Add a file under `dispatch/` with argv parsing → command call
 *   3. Add a row to the DISPATCH table below
 *   4. Add a row to `dispatch/shared.ts`'s help text
 *
 * Why not a Command-descriptor abstraction (parse/run pairs in a
 * registry, auto-generated help) — see CLI module doc. Short version:
 * descriptor patterns lose TS narrowing across the registry and force
 * `unknown`/`any`; the file-split here gets the readability win
 * without paying that cost.
 */

import { dispatchConfig } from "./dispatch/config.js";
import { dispatchKeys } from "./dispatch/keys.js";
import { dispatchModel } from "./dispatch/model.js";
import { dispatchProvider } from "./dispatch/provider.js";
import { dispatchRun } from "./dispatch/run.js";
import { dispatchSessions } from "./dispatch/sessions.js";
import { usage } from "./dispatch/shared.js";

type Dispatcher = (rest: string[]) => Promise<void>;

const DISPATCH: Record<string, Dispatcher> = {
  run: dispatchRun,
  sessions: dispatchSessions,
  provider: dispatchProvider,
  model: dispatchModel,
  keys: dispatchKeys,
  config: dispatchConfig,
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage(0);
  const head = argv[0]!;
  if (head === "-h" || head === "--help") usage(0);

  const handler = DISPATCH[head];
  if (!handler) {
    process.stderr.write(`huko: unknown command: ${head}\n`);
    usage();
  }

  await handler(argv.slice(1));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`huko: fatal: ${msg}\n`);
  process.exit(1);
});
