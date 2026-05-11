/**
 * server/cli/dispatch/config.ts
 *
 * `huko config <verb> [args] [flags]` — verb parsing for the runtime
 * config (HukoConfig) surface. Strictly verb-first; flag positions are
 * free.
 *
 * Verbs:
 *   show                                  — full layered dump
 *   get <path>                            — one value + which layer set it
 *   set <path> <value> [--project|--global]
 *   unset <path> [--project|--global]
 *
 * Default scope for set/unset is `--global` (writes to ~/.huko/config.json),
 * matching the convention used by `provider add` / `model add`. Use
 * `--project` to write to <cwd>/.huko/config.json instead.
 *
 * Returns exit code; usage() throws CliExitError on bad input.
 */

import {
  configGetCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
} from "../commands/config.js";
import { type ConfigScope } from "../../config/index.js";
import { usage } from "./shared.js";

export async function dispatchConfig(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined) {
    // Bare `huko config` falls through to `show` so users can sanity-
    // check their state. Same as before this commit.
    return await configShowCommand();
  }
  if (verb === "-h" || verb === "--help") usage(0);

  const args = rest.slice(1);

  switch (verb) {
    case "show":
      return await dispatchShow(args);
    case "get":
      return await dispatchGet(args);
    case "set":
      return await dispatchSet(args);
    case "unset":
      return await dispatchUnset(args);
    default:
      process.stderr.write(
        `huko config: unknown verb: ${verb} (try: show | get | set | unset)\n`,
      );
      usage();
  }
}

// ─── show ───────────────────────────────────────────────────────────────────

async function dispatchShow(args: string[]): Promise<number> {
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    process.stderr.write(`huko config show: unexpected argument: ${a}\n`);
    usage();
  }
  return await configShowCommand();
}

// ─── get <path> ─────────────────────────────────────────────────────────────

async function dispatchGet(args: string[]): Promise<number> {
  let path: string | undefined;
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a.startsWith("-")) {
      process.stderr.write(`huko config get: unknown flag: ${a}\n`);
      usage();
    }
    if (path !== undefined) {
      process.stderr.write(`huko config get: unexpected extra argument: ${a}\n`);
      usage();
    }
    path = a;
  }
  if (path === undefined) {
    process.stderr.write("huko config get: missing <path> (e.g. `huko config get mode`)\n");
    usage();
  }
  return await configGetCommand({ path });
}

// ─── set <path> <value> [--project|--global] ───────────────────────────────

async function dispatchSet(args: string[]): Promise<number> {
  const result = parseSetArgs(args);
  if (result.kind === "error") {
    process.stderr.write(result.message);
    usage();
  }
  return await configSetCommand({
    path: result.path,
    value: result.value,
    scope: result.scope,
  });
}

type ParseSetResult =
  | { kind: "ok"; path: string; value: string; scope: ConfigScope }
  | { kind: "error"; message: string };

function parseSetArgs(args: string[]): ParseSetResult {
  let path: string | undefined;
  let value: string | undefined;
  let scope: ConfigScope = "global";
  let scopeSet = false;

  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--project") {
      if (scopeSet && scope !== "project") {
        return { kind: "error", message: "huko config set: --global and --project are mutually exclusive\n" };
      }
      scope = "project";
      scopeSet = true;
      continue;
    }
    if (a === "--global") {
      if (scopeSet && scope !== "global") {
        return { kind: "error", message: "huko config set: --global and --project are mutually exclusive\n" };
      }
      scope = "global";
      scopeSet = true;
      continue;
    }
    if (a.startsWith("-")) {
      return { kind: "error", message: `huko config set: unknown flag: ${a}\n` };
    }
    if (path === undefined) {
      path = a;
      continue;
    }
    if (value === undefined) {
      value = a;
      continue;
    }
    return {
      kind: "error",
      message: `huko config set: unexpected extra argument: ${a}\n` +
        "         usage: huko config set <path> <value> [--project | --global]\n",
    };
  }

  if (path === undefined || value === undefined) {
    return {
      kind: "error",
      message: "huko config set: missing arguments.\n" +
        "         usage: huko config set <path> <value> [--project | --global]\n",
    };
  }
  return { kind: "ok", path, value, scope };
}

// ─── unset <path> [--project|--global] ─────────────────────────────────────

async function dispatchUnset(args: string[]): Promise<number> {
  let path: string | undefined;
  let scope: ConfigScope = "global";
  let scopeSet = false;

  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--project") {
      if (scopeSet && scope !== "project") {
        process.stderr.write("huko config unset: --global and --project are mutually exclusive\n");
        usage();
      }
      scope = "project";
      scopeSet = true;
      continue;
    }
    if (a === "--global") {
      if (scopeSet && scope !== "global") {
        process.stderr.write("huko config unset: --global and --project are mutually exclusive\n");
        usage();
      }
      scope = "global";
      scopeSet = true;
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`huko config unset: unknown flag: ${a}\n`);
      usage();
    }
    if (path !== undefined) {
      process.stderr.write(`huko config unset: unexpected extra argument: ${a}\n`);
      usage();
    }
    path = a;
  }

  if (path === undefined) {
    process.stderr.write(
      "huko config unset: missing <path>.\n" +
        "         usage: huko config unset <path> [--project | --global]\n",
    );
    usage();
  }

  return await configUnsetCommand({ path, scope });
}
