/**
 * server/cli/dispatch/safety.ts
 *
 * `huko safety <verb>` — verb routing for safety-policy management.
 *
 * Verbs:
 *   init [--project | --global]            — scaffold safety template
 *   list                                   — print active rules
 *   check <tool> <field>=<value> ...       — dry-run a hypothetical call
 *
 * Scope default for `init` is `--global` (matches the rest of huko's
 * config commands). `--project` writes into <cwd>/.huko/config.json.
 */

import {
  safetyCheckCommand,
  safetyInitCommand,
  safetyListCommand,
} from "../commands/safety.js";
import type { ConfigScope } from "../../config/index.js";
import { usage } from "./shared.js";

export async function dispatchSafety(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    if (verb === undefined) {
      process.stderr.write("huko safety: missing subcommand (init | list | check)\n");
    }
    usage(verb === undefined ? 3 : 0);
  }

  const args = rest.slice(1);
  switch (verb) {
    case "init":
      return dispatchInit(args);
    case "list":
      return dispatchList(args);
    case "check":
      return dispatchCheck(args);
    default:
      process.stderr.write(
        `huko safety: unknown verb: ${verb} (try: init | list | check)\n`,
      );
      usage();
  }
}

// ─── init ──────────────────────────────────────────────────────────────────

async function dispatchInit(args: string[]): Promise<number> {
  let scope: ConfigScope = "global";
  let scopeSet = false;
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--global") {
      if (scopeSet && scope !== "global") {
        process.stderr.write("huko safety init: --global and --project are mutually exclusive\n");
        usage();
      }
      scope = "global";
      scopeSet = true;
      continue;
    }
    if (a === "--project") {
      if (scopeSet && scope !== "project") {
        process.stderr.write("huko safety init: --global and --project are mutually exclusive\n");
        usage();
      }
      scope = "project";
      scopeSet = true;
      continue;
    }
    process.stderr.write(`huko safety init: unexpected argument: ${a}\n`);
    usage();
  }
  return await safetyInitCommand({ scope });
}

// ─── list ──────────────────────────────────────────────────────────────────

async function dispatchList(args: string[]): Promise<number> {
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    process.stderr.write(`huko safety list: unexpected argument: ${a}\n`);
    usage();
  }
  return await safetyListCommand();
}

// ─── check ─────────────────────────────────────────────────────────────────
//
// Argv shape: `huko safety check <tool> <field>=<value> [<field>=<value>...]`
// Examples:
//   huko safety check bash command='rm -rf /'
//   huko safety check write_file path=/etc/passwd
//   huko safety check move_file from=/a/b to=/c/d

async function dispatchCheck(args: string[]): Promise<number> {
  let toolName: string | undefined;
  const fields: Record<string, string> = {};

  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a.startsWith("--")) {
      process.stderr.write(`huko safety check: unexpected flag: ${a}\n`);
      usage();
    }
    if (toolName === undefined) {
      toolName = a;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(
        `huko safety check: expected <field>=<value>, got: ${a}\n` +
          `         example: huko safety check bash command='ls -la'\n`,
      );
      usage();
    }
    const key = a.slice(0, eq);
    const value = a.slice(eq + 1);
    fields[key] = value;
  }

  if (toolName === undefined) {
    process.stderr.write(
      "huko safety check: missing <tool> argument.\n" +
        "         usage: huko safety check <tool> <field>=<value> [...]\n",
    );
    usage();
  }
  return await safetyCheckCommand({ toolName, fields });
}
