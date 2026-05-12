/**
 * server/cli/commands/safety.ts
 *
 * Verbs:
 *   - `huko safety init [--project]`       — scaffold safety template into config.json
 *   - `huko safety list`                   — print every active rule + which layer
 *   - `huko safety check <tool> <field=value>...`
 *                                          — dry-run a hypothetical tool call
 *
 * All operate on the LAYERED `HukoConfig.safety` view (loaded via the
 * standard `loadConfig`), so they see the same effective rules the tool
 * pipeline does at runtime.
 */

import {
  evaluatePolicy,
  validateRules,
  MATCH_FIELDS,
  type PolicyDecision,
  type RuleValidationIssue,
} from "../../safety/policy.js";
import {
  appendRule,
  installSafetyTemplate,
  removeRulePattern,
  removeToolEntry,
  setToolDisabled,
  type InstallResult,
} from "../../safety/persist.js";
import { getConfig, loadConfig } from "../../config/index.js";
import {
  type ConfigScope,
  type HukoConfig,
  type ToolSafetyRules,
} from "../../config/index.js";
import { getTool, listToolNames } from "../../task/tools/registry.js";
import type { ToolDangerLevel } from "../../task/tools/registry.js";
import { bold, cyan, dim, green, magenta, red, yellow } from "../colors.js";

// ─── init ──────────────────────────────────────────────────────────────────

export async function safetyInitCommand(args: { scope: ConfigScope }): Promise<number> {
  try {
    const result: InstallResult = installSafetyTemplate(args.scope, process.cwd());
    const where = args.scope === "global" ? "global" : "project";
    switch (result.kind) {
      case "created":
        process.stderr.write(
          green(`huko: created ${result.filePath} with safety template (${where})\n`),
        );
        process.stderr.write(
          dim("       Edit the file to add deny / allow / requireConfirm patterns.\n"),
        );
        process.stderr.write(
          dim("       See `huko safety list` for the live merged view.\n"),
        );
        return 0;
      case "added":
        process.stderr.write(
          green(`huko: merged safety template into ${result.filePath} (${where})\n`),
        );
        process.stderr.write(
          dim("       Existing fields (mode, task, ...) were left untouched.\n"),
        );
        return 0;
      case "already_present":
        process.stderr.write(
          yellow(`huko: ${result.filePath} already has a \`safety\` section.\n`),
        );
        process.stderr.write(
          dim("       Run `huko safety list` to see active rules.\n"),
        );
        return 0;
    }
  } catch (err) {
    process.stderr.write(`huko: safety init failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── list ──────────────────────────────────────────────────────────────────

export async function safetyListCommand(): Promise<number> {
  try {
    loadConfig({ cwd: process.cwd() });
    const safety = getConfig().safety;

    process.stdout.write(bold("=== Default by dangerLevel ===") + "\n");
    for (const lvl of ["safe", "moderate", "dangerous"] as const) {
      process.stdout.write(`  ${lvl.padEnd(11)} ${cyan(safety.byDangerLevel[lvl])}\n`);
    }

    process.stdout.write("\n" + bold("=== Per-tool rules ===") + "\n");
    const toolNames = Object.keys(safety.toolRules).sort();
    if (toolNames.length === 0) {
      process.stdout.write(dim("  (none — add via `huko safety init` + edit the JSON)\n"));
    } else {
      for (const name of toolNames) {
        printToolRules(name, safety.toolRules[name]!);
      }
    }

    const issues = validateRules(safety.toolRules);
    if (issues.length > 0) {
      process.stdout.write("\n" + bold("=== Validation issues ===") + "\n");
      for (const i of issues) {
        process.stdout.write(
          red(
            `  ${i.toolName}.${i.bucket}[${i.index}]: ${i.pattern}  — ${i.problem}\n`,
          ),
        );
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety list failed: ${describe(err)}\n`);
    return 1;
  }
}

function printToolRules(name: string, rules: ToolSafetyRules): void {
  const tag = rules.disabled === true ? "  " + red("[disabled]") : "";
  process.stdout.write(`  ${cyan(name)}${tag}\n`);
  const fields = MATCH_FIELDS[name];
  if (fields) {
    process.stdout.write(dim(`    matches: ${fields.join(", ")}\n`));
  }
  for (const bucket of ["deny", "allow", "requireConfirm"] as const) {
    const list = rules[bucket];
    if (!list || list.length === 0) continue;
    process.stdout.write(`    ${bucket}:\n`);
    for (const p of list) {
      process.stdout.write(`      ${p}\n`);
    }
  }
}

// ─── check ─────────────────────────────────────────────────────────────────

export async function safetyCheckCommand(args: {
  toolName: string;
  /** Pre-parsed key=value pairs. */
  fields: Record<string, string>;
}): Promise<number> {
  try {
    loadConfig({ cwd: process.cwd() });
    const safety = getConfig().safety;

    const tool = getTool(args.toolName);
    if (!tool) {
      process.stderr.write(
        red(`huko safety check: unknown tool: ${args.toolName}\n`),
      );
      return 3;
    }
    const dangerLevel: ToolDangerLevel = tool.definition.dangerLevel ?? "safe";

    const decision: PolicyDecision = evaluatePolicy({
      toolName: args.toolName,
      args: args.fields,
      dangerLevel,
      safety,
    });

    process.stdout.write(`tool:        ${cyan(args.toolName)}\n`);
    process.stdout.write(`dangerLevel: ${dangerLevel}\n`);
    process.stdout.write(`args:        ${JSON.stringify(args.fields)}\n`);
    process.stdout.write("\n");
    process.stdout.write(`decision:    ${formatAction(decision.action)}\n`);
    if (decision.action !== "auto") {
      process.stdout.write(`source:      ${decision.source}\n`);
      if (decision.reason) process.stdout.write(`reason:      ${decision.reason}\n`);
      if (decision.matchedPattern !== undefined) {
        process.stdout.write(`matched:     pattern=${decision.matchedPattern} field=${decision.matchedField ?? "(?)"}\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety check failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── tool (list) ───────────────────────────────────────────────────────────

/**
 * `huko safety tool` — list every registered tool with its current
 * safety configuration: dangerLevel, [disabled] flag, count of
 * deny/allow/require patterns. The detailed pattern list is `safety
 * list`'s job; this view is the per-tool index.
 */
export async function safetyToolCommand(): Promise<number> {
  try {
    loadConfig({ cwd: process.cwd() });
    const safety = getConfig().safety;

    const names = listToolNames().sort();
    if (names.length === 0) {
      process.stdout.write(dim("(no tools registered — should not happen in a normal install)\n"));
      return 0;
    }

    const colName = Math.max(...names.map((n) => n.length), 4);
    const colDanger = "moderate".length;

    process.stdout.write(
      bold("=== Tools ===") + "\n" +
      dim(`  Use \`huko safety enable|disable <tool>\` to toggle, ` +
        `\`huko safety list\` for the rule details.\n\n`),
    );

    for (const name of names) {
      const tool = getTool(name);
      const dangerLevel: ToolDangerLevel = tool?.definition.dangerLevel ?? "safe";
      const rules = safety.toolRules[name];
      const isDisabled = rules?.disabled === true;
      const denyN = rules?.deny?.length ?? 0;
      const allowN = rules?.allow?.length ?? 0;
      const reqN = rules?.requireConfirm?.length ?? 0;

      const status = isDisabled
        ? red("DISABLED".padEnd(8))
        : dim("enabled ".padEnd(8));
      const dangerCol = colorDanger(dangerLevel).padEnd(colDanger + 8);
      const ruleSummary =
        denyN === 0 && allowN === 0 && reqN === 0
          ? dim("(no rules)")
          : `${denyN} deny / ${allowN} allow / ${reqN} require`;

      process.stdout.write(
        `  ${cyan(name).padEnd(colName + 9)}  ${status}  ${dangerCol}  ${ruleSummary}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety tool failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── enable / disable ──────────────────────────────────────────────────────

export async function safetyEnableCommand(args: {
  toolName: string;
  scope: ConfigScope;
}): Promise<number> {
  return await toggleDisabled(args.toolName, args.scope, false);
}

export async function safetyDisableCommand(args: {
  toolName: string;
  scope: ConfigScope;
}): Promise<number> {
  // Sanity: the tool must exist. We don't FORBID writing safety rules
  // for a tool that's not registered (e.g. a future workstation tool),
  // but disabling something nonexistent is almost certainly a typo.
  if (!getTool(args.toolName)) {
    process.stderr.write(
      red(`huko safety disable: unknown tool: ${args.toolName}\n`) +
      dim(`       see \`huko safety tool\` for the list of registered tools\n`),
    );
    return 3;
  }
  return await toggleDisabled(args.toolName, args.scope, true);
}

async function toggleDisabled(
  toolName: string,
  scope: ConfigScope,
  value: boolean,
): Promise<number> {
  try {
    const result = setToolDisabled(scope, process.cwd(), toolName, value);
    const where = scope === "global" ? "global" : "project";
    if (result.kind === "noop") {
      process.stderr.write(
        yellow(`huko: ${toolName} was already ${value ? "disabled" : "enabled"} in ${where}\n`),
      );
      return 0;
    }
    const verb = value ? "disabled" : "enabled";
    process.stderr.write(
      green(`huko: ${verb} ${toolName} (${where}: ${result.filePath})\n`),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety ${value ? "disable" : "enable"} failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── deny / allow / require (add a regex pattern) ──────────────────────────

export async function safetyAppendRuleCommand(args: {
  toolName: string;
  bucket: "deny" | "allow" | "requireConfirm";
  pattern: string;
  scope: ConfigScope;
}): Promise<number> {
  if (!getTool(args.toolName)) {
    process.stderr.write(
      red(`huko safety ${shortBucket(args.bucket)}: unknown tool: ${args.toolName}\n`) +
      dim(`       see \`huko safety tool\` for the list\n`),
    );
    return 3;
  }
  try {
    const result = appendRule(
      args.scope,
      process.cwd(),
      args.toolName,
      args.bucket,
      args.pattern,
    );
    const where = args.scope === "global" ? "global" : "project";
    if (result.kind === "already_present") {
      process.stderr.write(
        yellow(`huko: pattern already in ${args.toolName}.${args.bucket} (${where})\n`),
      );
      return 0;
    }
    process.stderr.write(
      green(
        `huko: added ${args.toolName}.${args.bucket} += ${args.pattern}  ` +
        `(${where}: ${result.filePath})\n`,
      ),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety ${shortBucket(args.bucket)} failed: ${describe(err)}\n`);
    return 1;
  }
}

function shortBucket(b: "deny" | "allow" | "requireConfirm"): string {
  return b === "requireConfirm" ? "require" : b;
}

// ─── unset (remove a pattern, or the whole tool entry) ────────────────────

export async function safetyUnsetCommand(args: {
  toolName: string;
  pattern?: string;
  scope: ConfigScope;
}): Promise<number> {
  try {
    const result = args.pattern !== undefined
      ? removeRulePattern(args.scope, process.cwd(), args.toolName, args.pattern)
      : removeToolEntry(args.scope, process.cwd(), args.toolName);
    const where = args.scope === "global" ? "global" : "project";

    if (result.kind === "not_found") {
      const target = args.pattern !== undefined
        ? `pattern ${args.pattern} in ${args.toolName}`
        : `entry for ${args.toolName}`;
      process.stderr.write(
        yellow(`huko: no ${target} in ${where} (${result.filePath}); nothing to do\n`),
      );
      return 0;
    }

    if (result.kind === "removed") {
      process.stderr.write(
        green(
          `huko: removed ${args.toolName}.${result.bucket} -= ${result.pattern}  ` +
          `(${where}: ${result.filePath})\n`,
        ),
      );
    } else {
      process.stderr.write(
        green(
          `huko: removed all rules + disabled flag for ${args.toolName}  ` +
          `(${where}: ${result.filePath})\n`,
        ),
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: safety unset failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatAction(a: "auto" | "deny" | "prompt"): string {
  if (a === "auto") return green(a);
  if (a === "deny") return red(a);
  return yellow(a);
}

function colorDanger(d: ToolDangerLevel): string {
  if (d === "dangerous") return magenta(d);
  if (d === "moderate") return yellow(d);
  return dim(d);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export ToolSafetyRules so the dispatcher's type imports stay simple.
export type { RuleValidationIssue };
// Suppress unused warning — HukoConfig is referenced in type position
// only via the imported config index, but listing it here helps future
// maintainers understand the shape.
export type _SafetyShape = HukoConfig["safety"];
