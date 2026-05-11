/**
 * server/config/writer.ts
 *
 * Path-based read/write for `HukoConfig` files. Used by
 * `huko config get|set|unset <path>` to surgically mutate one field in
 * `~/.huko/config.json` (global) or `<cwd>/.huko/config.json` (project),
 * without rewriting the rest of the file.
 *
 * Design notes:
 *   - Paths are dot-separated identifiers ("task.maxIterations"). Keys
 *     with dots in them are not supported (we don't have any).
 *   - The path must exist in `DEFAULT_CONFIG`. This catches typos at
 *     write time instead of letting them silently ignore.
 *   - The supplied value's runtime type must match the default at that
 *     path (string/number/boolean). Heuristic CLI value parsing lives
 *     here so the dispatcher stays thin.
 *   - A small whitelist of string-enum paths (`mode`, `cli.format`,
 *     `tools.webSearch.provider`) gets enum-membership validation. Open
 *     strings (e.g. `daemon.host`) pass through.
 *   - Writes are atomic (write-tmp + rename). The file's other fields
 *     survive untouched. Missing files become `{}` then get the value.
 *
 * Not handled (out of scope for v1):
 *   - Array indexing in paths
 *   - Type coercion across types ("1" → true)
 *   - Comment preservation in JSON (we strip `_comment*` on read but
 *     don't round-trip them; the loader does that)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_CONFIG, type HukoConfig } from "./types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

export type ConfigScope = "global" | "project";

export function globalConfigPath(): string {
  return path.join(os.homedir(), ".huko", "config.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".huko", "config.json");
}

export function scopePath(scope: ConfigScope, cwd: string): string {
  return scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
}

// ─── Enum whitelist ─────────────────────────────────────────────────────────
//
// TypeScript string-literal unions vanish at runtime, so we hand-curate a
// table of paths whose values must come from a fixed set. New enum
// configs add one line here. Open strings (like `daemon.host`) are not
// listed and pass enum validation trivially.

export const ENUM_PATHS: Record<string, readonly string[]> = {
  "mode": ["lean", "full"],
  "cli.format": ["text", "jsonl", "json"],
  "tools.webSearch.provider": ["duckduckgo"],
};

// ─── Path helpers ───────────────────────────────────────────────────────────

export function parsePath(p: string): string[] {
  if (p.length === 0) return [];
  return p.split(".");
}

export function getValueByPath(obj: unknown, path: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/**
 * Return a SHALLOW-COPIED object tree with `value` set at `path`. The
 * input is not mutated — every intermediate object along the path is
 * recreated so the caller can use referential-equality checks if needed.
 *
 * Missing intermediate keys are created as plain objects.
 */
export function setValueByPath(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error("setValueByPath: empty path");
  }
  const out: Record<string, unknown> = { ...obj };
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = cursor[key];
    const next: Record<string, unknown> =
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = next;
    cursor = next;
  }
  cursor[path[path.length - 1]!] = value;
  return out;
}

/**
 * Return a SHALLOW-COPIED object tree with the field at `path` deleted.
 * Empty parent objects left behind are NOT pruned — keeping them is
 * harmless and avoids surprising users who set siblings later.
 *
 * Returns the (possibly unchanged) tree even when the path was absent.
 */
export function unsetValueByPath(obj: Record<string, unknown>, path: string[]): Record<string, unknown> {
  if (path.length === 0) return obj;
  if (getValueByPath(obj, path) === undefined) return obj;
  const out: Record<string, unknown> = { ...obj };
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = cursor[key];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      return obj;
    }
    const next = { ...(existing as Record<string, unknown>) };
    cursor[key] = next;
    cursor = next;
  }
  delete cursor[path[path.length - 1]!];
  return out;
}

// ─── Schema inference (from DEFAULT_CONFIG) ─────────────────────────────────

export type LeafType = "string" | "number" | "boolean";

export type PathSchema =
  | { kind: "leaf"; type: LeafType; enum?: readonly string[] }
  | { kind: "unknown_path"; tried: string }
  | { kind: "not_a_leaf"; tried: string };

/**
 * Inspect `DEFAULT_CONFIG` at `path` to determine what shape the user is
 * allowed to write there. Returns:
 *   - `leaf`           — a primitive field; `type` says what kind
 *   - `unknown_path`   — the path doesn't exist in DEFAULT_CONFIG
 *   - `not_a_leaf`     — the path resolves to an object (you can't
 *                        `set` a whole subtree from the CLI)
 */
export function inferPathSchema(p: string): PathSchema {
  const parts = parsePath(p);
  if (parts.length === 0) return { kind: "unknown_path", tried: p };

  const value = getValueByPath(DEFAULT_CONFIG as unknown, parts);
  if (value === undefined) return { kind: "unknown_path", tried: p };

  if (value === null || typeof value === "object") {
    return { kind: "not_a_leaf", tried: p };
  }

  const t = typeof value;
  if (t !== "string" && t !== "number" && t !== "boolean") {
    // Defensive — DEFAULT_CONFIG has no such fields today.
    return { kind: "unknown_path", tried: p };
  }

  const enumList = ENUM_PATHS[p];
  const leaf: PathSchema = enumList
    ? { kind: "leaf", type: t, enum: enumList }
    : { kind: "leaf", type: t };
  return leaf;
}

// ─── Value parsing ──────────────────────────────────────────────────────────

export type ParseValueResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; error: string };

/**
 * Parse a CLI-supplied string into a typed value matching `schema`.
 *
 * Heuristic:
 *   - For boolean schema:  "true"/"false" (case-insensitive) only.
 *   - For number schema:   Number(raw) must be finite.
 *   - For string schema:   raw is taken verbatim. Enum membership
 *                          checked against `schema.enum` if set.
 *
 * No cross-type coercion — `"1"` does NOT become `true` for a boolean
 * field. Errors surface as a one-line operator-facing message.
 */
export function parseValue(raw: string, schema: { type: LeafType; enum?: readonly string[] }): ParseValueResult {
  if (schema.type === "boolean") {
    const lc = raw.trim().toLowerCase();
    if (lc === "true") return { ok: true, value: true };
    if (lc === "false") return { ok: true, value: false };
    return { ok: false, error: `expected true | false, got ${JSON.stringify(raw)}` };
  }
  if (schema.type === "number") {
    // Trim first — Number("") and Number("  ") both yield 0, which is
    // a JS oddity we don't want to inherit.
    const trimmed = raw.trim();
    if (trimmed === "") {
      return { ok: false, error: `expected a number, got ${JSON.stringify(raw)}` };
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `expected a number, got ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: n };
  }
  // string
  if (schema.enum && !schema.enum.includes(raw)) {
    return {
      ok: false,
      error: `expected one of [${schema.enum.join(", ")}], got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, value: raw };
}

// ─── File I/O ───────────────────────────────────────────────────────────────

/**
 * Read the raw on-disk layer (NOT merged). Returns `{}` if the file is
 * absent or empty. Throws on malformed JSON with the path in the error.
 */
export function readLayerFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config-writer: cannot read ${filePath}: ${msg}`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config-writer: ${filePath} is not valid JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config-writer: ${filePath} must contain a JSON object at top level`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Atomic write — write to a sibling tmp file, then rename. The rename
 * step is atomic on every fs we care about (POSIX, NTFS). Creates the
 * parent `.huko/` directory if missing.
 */
export function writeLayerFile(filePath: string, contents: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(contents, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow — orphan tmp is harmless */
    }
    throw err;
  }
}

// ─── Top-level set / unset ─────────────────────────────────────────────────

export type SetConfigResult =
  | { ok: true; previous: unknown; next: string | number | boolean; filePath: string }
  | { ok: false; error: string };

/**
 * Resolve the schema, parse the value, deep-set into the on-disk file
 * at the given scope, and atomic-write. Pure error/value envelope —
 * the caller (CLI command) is responsible for stderr output.
 */
export function setConfigValue(opts: {
  path: string;
  value: string;
  scope: ConfigScope;
  cwd: string;
}): SetConfigResult {
  const parts = parsePath(opts.path);
  const schema = inferPathSchema(opts.path);
  if (schema.kind === "unknown_path") {
    return { ok: false, error: `unknown config path: ${opts.path}` };
  }
  if (schema.kind === "not_a_leaf") {
    return {
      ok: false,
      error: `${opts.path} is an object, not a primitive — set its leaf fields one at a time`,
    };
  }
  const parsed = parseValue(opts.value, schema);
  if (!parsed.ok) {
    return { ok: false, error: `${opts.path}: ${parsed.error}` };
  }

  const filePath = scopePath(opts.scope, opts.cwd);
  const file = readLayerFile(filePath);
  const previous = getValueByPath(file, parts);
  const next = setValueByPath(file, parts, parsed.value);
  writeLayerFile(filePath, next);
  return { ok: true, previous, next: parsed.value, filePath };
}

export type UnsetConfigResult =
  | { ok: true; removed: boolean; previous: unknown; filePath: string }
  | { ok: false; error: string };

/**
 * Remove a path from the given scope's on-disk file. `removed` is false
 * if the path was already absent (caller can surface "nothing to remove"
 * vs. "removed X" UX).
 */
export function unsetConfigValue(opts: {
  path: string;
  scope: ConfigScope;
  cwd: string;
}): UnsetConfigResult {
  const parts = parsePath(opts.path);
  const schema = inferPathSchema(opts.path);
  if (schema.kind === "unknown_path") {
    return { ok: false, error: `unknown config path: ${opts.path}` };
  }
  // not_a_leaf is allowed for unset (you can remove a whole subtree),
  // but we still validate the path exists in the schema.

  const filePath = scopePath(opts.scope, opts.cwd);
  const file = readLayerFile(filePath);
  const previous = getValueByPath(file, parts);
  if (previous === undefined) {
    return { ok: true, removed: false, previous: undefined, filePath };
  }
  const next = unsetValueByPath(file, parts);
  writeLayerFile(filePath, next);
  return { ok: true, removed: true, previous, filePath };
}

/**
 * Expose the typed default so commands can flag-format the schema for
 * error messages without re-importing DEFAULT_CONFIG.
 */
export function getDefaultConfig(): HukoConfig {
  return DEFAULT_CONFIG;
}
