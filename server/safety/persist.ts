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

// ─── Toggle disabled flag ──────────────────────────────────────────────────

export type SetDisabledResult =
  | { kind: "set"; filePath: string; previous: boolean | undefined }
  | { kind: "noop"; filePath: string };

/**
 * Toggle `safety.toolRules.<toolName>.disabled`. Two operations:
 *   - `value=true`  → set the field; no-op if already `true`
 *   - `value=false` → REMOVE the field (we treat absent and `false`
 *                     identically to keep the schema clean — see the
 *                     `disabled?: boolean` doc comment in config/types.ts)
 *
 * If removing the disabled flag leaves the tool entry empty (no
 * deny/allow/require either), the entry itself is removed. Same goes
 * for the surrounding `toolRules` and `safety` objects when they
 * become empty — keeps the on-disk JSON tidy.
 */
export function setToolDisabled(
  scope: ConfigScope,
  cwd: string,
  toolName: string,
  value: boolean,
): SetDisabledResult {
  const filePath = scopePath(scope, cwd);
  const file = readLayerFile(filePath);

  const safety = isPlainObject(file["safety"]) ? { ...file["safety"] } : {};
  const toolRulesRaw = safety["toolRules"];
  const toolRules = isPlainObject(toolRulesRaw) ? { ...toolRulesRaw } : {};
  const toolEntryRaw = toolRules[toolName];
  const toolEntry = isPlainObject(toolEntryRaw) ? { ...toolEntryRaw } : {};

  const previous = typeof toolEntry["disabled"] === "boolean"
    ? (toolEntry["disabled"] as boolean)
    : undefined;

  if (value === true) {
    if (previous === true) return { kind: "noop", filePath };
    toolEntry["disabled"] = true;
  } else {
    if (previous === undefined) return { kind: "noop", filePath };
    delete toolEntry["disabled"];
  }

  // Tidy up empty levels left behind.
  if (Object.keys(toolEntry).length === 0) {
    delete toolRules[toolName];
  } else {
    toolRules[toolName] = toolEntry;
  }
  if (Object.keys(toolRules).length === 0) {
    delete safety["toolRules"];
  } else {
    safety["toolRules"] = toolRules;
  }

  let next: Record<string, unknown>;
  if (Object.keys(safety).length === 0) {
    next = { ...file };
    delete next["safety"];
  } else {
    next = { ...file, safety };
  }
  writeLayerFile(filePath, next);

  return { kind: "set", filePath, previous };
}

// ─── Remove rule patterns / whole tool entries ────────────────────────────

export type RemoveRuleResult =
  | { kind: "removed"; filePath: string; bucket: Bucket; pattern: string }
  | { kind: "removed_all"; filePath: string }
  | { kind: "not_found"; filePath: string };

type Bucket = "deny" | "allow" | "requireConfirm";
const BUCKETS: Bucket[] = ["deny", "allow", "requireConfirm"];

/**
 * Remove a regex pattern from the first bucket that contains it.
 * Returns `not_found` if no bucket has it.
 *
 * This is used by `huko safety unset <tool> <pattern>`. The user
 * doesn't have to specify which bucket — we search deny → allow →
 * requireConfirm in order. Same pattern in multiple buckets is rare
 * (and would need explicit per-bucket commands to manage).
 */
export function removeRulePattern(
  scope: ConfigScope,
  cwd: string,
  toolName: string,
  pattern: string,
): RemoveRuleResult {
  const filePath = scopePath(scope, cwd);
  const file = readLayerFile(filePath);

  const safety = isPlainObject(file["safety"]) ? { ...file["safety"] } : {};
  const toolRulesRaw = safety["toolRules"];
  const toolRules = isPlainObject(toolRulesRaw) ? { ...toolRulesRaw } : {};
  const toolEntryRaw = toolRules[toolName];
  if (!isPlainObject(toolEntryRaw)) return { kind: "not_found", filePath };
  const toolEntry = { ...toolEntryRaw };

  let removedFrom: Bucket | undefined;
  for (const bucket of BUCKETS) {
    const arrRaw = toolEntry[bucket];
    if (!Array.isArray(arrRaw)) continue;
    const arr = arrRaw.filter((x): x is string => typeof x === "string");
    if (!arr.includes(pattern)) continue;
    const next = arr.filter((p) => p !== pattern);
    if (next.length === 0) delete toolEntry[bucket];
    else toolEntry[bucket] = next;
    removedFrom = bucket;
    break;
  }

  if (removedFrom === undefined) return { kind: "not_found", filePath };

  // Tidy up.
  if (Object.keys(toolEntry).length === 0) {
    delete toolRules[toolName];
  } else {
    toolRules[toolName] = toolEntry;
  }
  if (Object.keys(toolRules).length === 0) delete safety["toolRules"];
  else safety["toolRules"] = toolRules;

  let nextFile: Record<string, unknown>;
  if (Object.keys(safety).length === 0) {
    nextFile = { ...file };
    delete nextFile["safety"];
  } else {
    nextFile = { ...file, safety };
  }
  writeLayerFile(filePath, nextFile);

  return { kind: "removed", filePath, bucket: removedFrom, pattern };
}

/**
 * Remove the entire `toolRules.<toolName>` entry — wipes deny / allow /
 * requireConfirm AND the `disabled` flag. Used by
 * `huko safety unset <tool>` (no pattern arg).
 */
export function removeToolEntry(
  scope: ConfigScope,
  cwd: string,
  toolName: string,
): RemoveRuleResult {
  const filePath = scopePath(scope, cwd);
  const file = readLayerFile(filePath);

  const safety = isPlainObject(file["safety"]) ? { ...file["safety"] } : {};
  const toolRulesRaw = safety["toolRules"];
  const toolRules = isPlainObject(toolRulesRaw) ? { ...toolRulesRaw } : {};
  if (!isPlainObject(toolRules[toolName])) {
    return { kind: "not_found", filePath };
  }
  delete toolRules[toolName];

  if (Object.keys(toolRules).length === 0) delete safety["toolRules"];
  else safety["toolRules"] = toolRules;

  let nextFile: Record<string, unknown>;
  if (Object.keys(safety).length === 0) {
    nextFile = { ...file };
    delete nextFile["safety"];
  } else {
    nextFile = { ...file, safety };
  }
  writeLayerFile(filePath, nextFile);

  return { kind: "removed_all", filePath };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
