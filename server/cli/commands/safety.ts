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
  installSafetyTemplate,
  type InstallResult,
} from "../../safety/persist.js";
import { getConfig, loadConfig } from "../../config/index.js";
import {
  type ConfigScope,
  type HukoConfig,
  type ToolSafetyRules,
} from "../../config/index.js";
import { getTool } from "../../task/tools/registry.js";
import type { ToolDangerLevel } from "../../task/tools/registry.js";
import { bold, cyan, dim, green, red, yellow } from "../colors.js";

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
  process.stdout.write(`  ${cyan(name)}\n`);
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

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatAction(a: "auto" | "deny" | "prompt"): string {
  if (a === "auto") return green(a);
  if (a === "deny") return red(a);
  return yellow(a);
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
