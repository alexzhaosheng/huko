/**
 * server/cli/dispatch/vault.ts
 *
 * `huko vault <verb>` — argv parser + handoff to commands/vault.
 *
 * Verbs:
 *   add <name> [--value <s>]   — register a secret string (hidden prompt
 *                                if --value not given)
 *   remove <name>              — unregister
 *   list                       — names + length + addedAt (NEVER values)
 *   test                       — pipe text in, see redacted output
 *
 * Vault is GLOBAL only (`~/.huko/vault.json`); no `--global` /
 * `--project` flag. Project-specific redactions belong in
 * `safety.redactPatterns` (Layer 2 regex), not here.
 */

import {
  vaultAddCommand,
  vaultListCommand,
  vaultRemoveCommand,
  vaultTestCommand,
} from "../commands/vault.js";
import { usage as baseUsage } from "./shared.js";
import { renderVaultHelp } from "./help.js";

function usage(code: number = 3): never {
  return baseUsage(code, renderVaultHelp);
}

const VERBS_HELP = "add | remove | list | test";

export async function dispatchVault(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    if (verb === undefined) {
      process.stderr.write(`huko vault: missing subcommand (${VERBS_HELP})\n`);
    }
    usage(verb === undefined ? 3 : 0);
  }
  const args = rest.slice(1);

  switch (verb) {
    case "add":
      return dispatchAdd(args);
    case "remove":
      return dispatchRemove(args);
    case "list":
      return dispatchList(args);
    case "test":
      return dispatchTest(args);
    default:
      process.stderr.write(`huko vault: unknown verb: ${verb} (${VERBS_HELP})\n`);
      usage();
  }
}

// ─── add ────────────────────────────────────────────────────────────────────

async function dispatchAdd(args: string[]): Promise<number> {
  let name: string | undefined;
  let inlineValue: string | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--value") {
      const next = args[i + 1];
      if (next === undefined) {
        process.stderr.write("huko vault add: --value requires a value\n");
        usage();
      }
      inlineValue = next;
      i += 2;
      continue;
    }
    if (a.startsWith("--value=")) {
      inlineValue = a.slice("--value=".length);
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`huko vault add: unknown flag: ${a}\n`);
      usage();
    }
    if (name === undefined) {
      name = a;
      i++;
      continue;
    }
    process.stderr.write(`huko vault add: unexpected argument: ${a}\n`);
    usage();
  }
  if (name === undefined) {
    process.stderr.write(
      "huko vault add: missing <name>\n" +
        "         usage: huko vault add <name> [--value <secret>]\n" +
        "         (without --value, you'll be prompted for the secret with hidden input)\n",
    );
    usage();
  }
  return await vaultAddCommand({
    name,
    ...(inlineValue !== undefined ? { inlineValue } : {}),
  });
}

// ─── remove ─────────────────────────────────────────────────────────────────

async function dispatchRemove(args: string[]): Promise<number> {
  let name: string | undefined;
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a.startsWith("-")) {
      process.stderr.write(`huko vault remove: unknown flag: ${a}\n`);
      usage();
    }
    if (name !== undefined) {
      process.stderr.write(`huko vault remove: unexpected extra argument: ${a}\n`);
      usage();
    }
    name = a;
  }
  if (name === undefined) {
    process.stderr.write("huko vault remove: missing <name>\n");
    usage();
  }
  return await vaultRemoveCommand({ name });
}

// ─── list ───────────────────────────────────────────────────────────────────

async function dispatchList(args: string[]): Promise<number> {
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    process.stderr.write(`huko vault list: unexpected argument: ${a}\n`);
    usage();
  }
  return await vaultListCommand();
}

// ─── test ───────────────────────────────────────────────────────────────────

async function dispatchTest(args: string[]): Promise<number> {
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    process.stderr.write(`huko vault test: unexpected argument: ${a}\n`);
    usage();
  }
  return await vaultTestCommand();
}
