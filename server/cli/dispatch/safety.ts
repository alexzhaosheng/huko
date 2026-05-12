/**
 * server/cli/dispatch/safety.ts
 *
 * `huko safety <verb>` — verb routing for safety-policy management.
 *
 * Verbs (rule editing):
 *   tool                                  — list all tools + per-tool config
 *   enable <tool>                         — re-enable a previously disabled tool
 *   disable <tool>                        — remove the tool from the LLM surface
 *   deny    <tool> <pattern>              — append regex to deny bucket
 *   allow   <tool> <pattern>              — append regex to allow bucket
 *   require <tool> <pattern>              — append regex to requireConfirm bucket
 *   unset   <tool> [pattern]              — remove a single pattern, or wipe the entry
 *
 * Verbs (read-only / setup):
 *   init                                  — scaffold safety template
 *   list                                  — print active rules with patterns
 *   check <tool> <field>=<value> ...      — dry-run a hypothetical call
 *
 * Scope: ALL editing verbs default to PROJECT (`<cwd>/.huko/config.json`)
 * because safety policy is overwhelmingly per-project (different repos
 * have different risk profiles). Pass `--global` to write to
 * `~/.huko/config.json` instead. This is the inverse of provider/model
 * commands, which default global because providers ARE machine-wide.
 */

import {
  safetyAppendRuleCommand,
  safetyCheckCommand,
  safetyDisableCommand,
  safetyEnableCommand,
  safetyInitCommand,
  safetyListCommand,
  safetyToolCommand,
  safetyUnsetCommand,
} from "../commands/safety.js";
import type { ConfigScope } from "../../config/index.js";
import { usage } from "./shared.js";

const VERBS_HELP =
  "init | list | tool | check | enable | disable | deny | allow | require | unset";

export async function dispatchSafety(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    if (verb === undefined) {
      process.stderr.write(`huko safety: missing subcommand (${VERBS_HELP})\n`);
    }
    usage(verb === undefined ? 3 : 0);
  }

  const args = rest.slice(1);
  switch (verb) {
    case "init":
      return dispatchInit(args);
    case "list":
      return dispatchList(args);
    case "tool":
      return dispatchTool(args);
    case "check":
      return dispatchCheck(args);
    case "enable":
      return dispatchEnableDisable(args, true);
    case "disable":
      return dispatchEnableDisable(args, false);
    case "deny":
      return dispatchAppendRule(args, "deny");
    case "allow":
      return dispatchAppendRule(args, "allow");
    case "require":
      return dispatchAppendRule(args, "requireConfirm");
    case "unset":
      return dispatchUnset(args);
    default:
      process.stderr.write(`huko safety: unknown verb: ${verb} (${VERBS_HELP})\n`);
      usage();
  }
}

// ─── Scope-flag helper ────────────────────────────────────────────────────
//
// Editing verbs default to PROJECT scope; `--global` (or its alias
// `--project`) is the explicit override. Returns the resolved scope and
// the leftover argv (with the scope flags stripped).

function pullScope(args: string[]): { scope: ConfigScope; rest: string[] } {
  let global = false;
  let projectExplicit = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--global") {
      global = true;
      continue;
    }
    if (a === "--project") {
      projectExplicit = true;
      continue;
    }
    rest.push(a);
  }
  if (global && projectExplicit) {
    process.stderr.write("huko safety: --global and --project are mutually exclusive\n");
    usage();
  }
  return { scope: global ? "global" : "project", rest };
}

// ─── init ──────────────────────────────────────────────────────────────────

async function dispatchInit(args: string[]): Promise<number> {
  const { scope, rest } = pullScope(args);
  for (const a of rest) {
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

// ─── tool (list-all-tools index) ──────────────────────────────────────────

async function dispatchTool(args: string[]): Promise<number> {
  for (const a of args) {
    if (a === "-h" || a === "--help") usage(0);
    process.stderr.write(`huko safety tool: unexpected argument: ${a}\n`);
    usage();
  }
  return await safetyToolCommand();
}

// ─── enable / disable ────────────────────────────────────────────────────

async function dispatchEnableDisable(
  args: string[],
  enable: boolean,
): Promise<number> {
  const verb = enable ? "enable" : "disable";
  const { scope, rest } = pullScope(args);
  if (rest.length === 0) {
    process.stderr.write(
      `huko safety ${verb}: missing <tool>\n` +
      `         usage: huko safety ${verb} <tool> [--global]\n`,
    );
    usage();
  }
  if (rest.length > 1) {
    process.stderr.write(
      `huko safety ${verb}: too many arguments (only <tool> is allowed)\n`,
    );
    usage();
  }
  const toolName = rest[0]!;
  return enable
    ? safetyEnableCommand({ toolName, scope })
    : safetyDisableCommand({ toolName, scope });
}

// ─── deny / allow / require ──────────────────────────────────────────────

async function dispatchAppendRule(
  args: string[],
  bucket: "deny" | "allow" | "requireConfirm",
): Promise<number> {
  const verbName = bucket === "requireConfirm" ? "require" : bucket;
  const { scope, rest } = pullScope(args);
  if (rest.length < 2) {
    process.stderr.write(
      `huko safety ${verbName}: missing arguments\n` +
      `         usage: huko safety ${verbName} <tool> <pattern> [--global]\n`,
    );
    usage();
  }
  if (rest.length > 2) {
    process.stderr.write(
      `huko safety ${verbName}: too many arguments\n` +
      `         (got: ${rest.slice(2).join(" ")})\n` +
      `         If your pattern contains spaces, quote it.\n`,
    );
    usage();
  }
  const toolName = rest[0]!;
  const pattern = rest[1]!;
  return await safetyAppendRuleCommand({ toolName, bucket, pattern, scope });
}

// ─── unset ────────────────────────────────────────────────────────────────

async function dispatchUnset(args: string[]): Promise<number> {
  const { scope, rest } = pullScope(args);
  if (rest.length === 0) {
    process.stderr.write(
      "huko safety unset: missing <tool>\n" +
      "         usage: huko safety unset <tool> [<pattern>] [--global]\n" +
      "         (no <pattern> = wipe the entire entry, including disabled flag)\n",
    );
    usage();
  }
  if (rest.length > 2) {
    process.stderr.write(
      `huko safety unset: too many arguments (got: ${rest.slice(2).join(" ")})\n`,
    );
    usage();
  }
  const toolName = rest[0]!;
  const pattern = rest[1];
  return await safetyUnsetCommand({
    toolName,
    ...(pattern !== undefined ? { pattern } : {}),
    scope,
  });
}

// ─── check (unchanged) ────────────────────────────────────────────────────
//
// Argv shape: `huko safety check <tool> <field>=<value> [<field>=<value>...]`

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
