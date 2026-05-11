/**
 * server/safety/persist.ts
 *
 * Small persistence helpers specific to the safety domain. The generic
 * `config/writer.ts` exposes `setConfigValue(path, value)` for scalar
 * leaves, but the safety section needs ARRAY APPEND semantics (e.g.
 * "operator clicked 'always allow', add this pattern to bash.allow"),
 * which the path-based setter can't express cleanly.
 *
 * Public API:
 *   - installSafetyTemplate(scope, cwd)  — idempotent scaffold writer
 *   - appendRule(scope, cwd, toolName, bucket, pattern)
 *
 * Both functions read the on-disk file via the writer's primitives, do
 * the surgical mutation, and atomic-write the result back. They preserve
 * every other field in the config (mode, task.*, etc.) untouched.
 */

import {
  readLayerFile,
  scopePath,
  writeLayerFile,
  type ConfigScope,
} from "../config/writer.js";
import { buildSafetyTemplate } from "./scaffold.js";

// ─── Scaffold install ──────────────────────────────────────────────────────

export type InstallResult =
  | { kind: "created"; filePath: string }
  | { kind: "added"; filePath: string }
  | { kind: "already_present"; filePath: string };

/**
 * Inject the safety template into the given scope's config.json. Three
 * outcomes:
 *   - `created`         — file didn't exist; wrote a new one with just
 *                         `safety`. (Sibling fields stay absent.)
 *   - `added`           — file existed but had no `safety` key. Merged.
 *   - `already_present` — `safety` already there. No-op; tell operator
 *                         to `huko safety list` instead of clobbering.
 */
export function installSafetyTemplate(
  scope: ConfigScope,
  cwd: string,
): InstallResult {
  const filePath = scopePath(scope, cwd);
  const file = readLayerFile(filePath);

  if (
    file["safety"] !== undefined &&
    file["safety"] !== null &&
    typeof file["safety"] === "object"
  ) {
    return { kind: "already_present", filePath };
  }

  const template = buildSafetyTemplate();
  const existed = Object.keys(file).length > 0;
  const next = { ...file, safety: template };
  writeLayerFile(filePath, next);

  return existed
    ? { kind: "added", filePath }
    : { kind: "created", filePath };
}

// ─── Append rule (for "always allow" decision outcome) ────────────────────

export type AppendRuleResult =
  | { kind: "appended"; filePath: string }
  | { kind: "already_present"; filePath: string };

/**
 * Append `pattern` to `safety.toolRules.<toolName>.<bucket>` in the
 * scope's config.json. Used when the operator picks "always allow" at
 * a confirmation prompt — the matched pattern (or the literal command
 * if no pattern triggered) is persisted so future calls skip the prompt.
 *
 * - Creates `safety` / `safety.toolRules` / the tool entry / the bucket
 *   along the way if missing.
 * - Skips append if the pattern is already in the list — idempotent.
 */
export function appendRule(
  scope: ConfigScope,
  cwd: string,
  toolName: string,
  bucket: "deny" | "allow" | "requireConfirm",
  pattern: string,
): AppendRuleResult {
  const filePath = scopePath(scope, cwd);
  const file = readLayerFile(filePath);

  // Walk / create the path safety → toolRules → <toolName>.
  const safety = isPlainObject(file["safety"]) ? { ...file["safety"] } : {};
  const toolRulesRaw = safety["toolRules"];
  const toolRules = isPlainObject(toolRulesRaw) ? { ...toolRulesRaw } : {};
  const toolEntryRaw = toolRules[toolName];
  const toolEntry = isPlainObject(toolEntryRaw) ? { ...toolEntryRaw } : {};

  const bucketArrRaw = toolEntry[bucket];
  const bucketArr = Array.isArray(bucketArrRaw)
    ? bucketArrRaw.filter((x): x is string => typeof x === "string")
    : [];

  if (bucketArr.includes(pattern)) {
    return { kind: "already_present", filePath };
  }

  toolEntry[bucket] = [...bucketArr, pattern];
  toolRules[toolName] = toolEntry;
  safety["toolRules"] = toolRules;

  const next = { ...file, safety };
  writeLayerFile(filePath, next);

  return { kind: "appended", filePath };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
