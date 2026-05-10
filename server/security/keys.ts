/**
 * server/security/keys.ts
 *
 * API-key resolution + write helpers. Provider definitions never carry
 * a plaintext key — they only hold a logical name (e.g. `"openrouter"`).
 * `resolveApiKey(ref, opts)` turns that name into the actual secret at
 * runtime via a four-layer lookup:
 *
 *   1. <cwd>/.huko/keys.json      project-local explicit (highest)
 *   2. ~/.huko/keys.json          user-global (across every project)
 *   3. process.env                shell / system env vars
 *   4. <cwd>/.env                 project-local dotenv (lowest)
 *
 * Layer 1 lets a single project override what the rest of the user's
 * machine sees (CI vs personal, work vs personal). Layer 2 is the "set
 * one key, every project on this machine sees it" convenience the setup
 * wizard writes to. Layers 3 and 4 are the existing env-friendly paths.
 *
 * Naming convention for env vars: `<REF.toUpperCase()>_API_KEY`, so the
 * ref `"openrouter"` looks for `OPENROUTER_API_KEY` in env and `.env`.
 * The keys.json files (both project and global) are keyed directly by
 * ref, so `{ "openrouter": "..." }`.
 *
 * The split-from-config design keeps `providers.json` (which can be
 * checked into git per-project) free of plaintext credentials.
 *
 * Set/unset helpers chmod 600 on Unix. They power `huko keys set` /
 * `huko setup`; the resolver itself is read-only.
 *
 * NOTE: read paths use synchronous fs on each call. That's fine — keys
 * live in tiny files, lookups happen at task startup, and orchestrator
 * caches per-task. If resolution shows up in profiles, add a per-process
 * cache here.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ResolveKeyOptions = {
  /**
   * Working directory for project-local lookups (`.huko/keys.json`,
   * `.env`). Defaults to `process.cwd()`.
   */
  cwd?: string;
};

/**
 * Resolve `ref` to a non-empty key string, or throw with a message
 * spelling out the four places the user can put it.
 */
export function resolveApiKey(ref: string, opts: ResolveKeyOptions = {}): string {
  if (!ref || ref.trim() === "") {
    throw new Error("resolveApiKey called with empty ref");
  }
  const cwd = opts.cwd ?? process.cwd();
  const envName = envVarNameFor(ref);

  // 1. <cwd>/.huko/keys.json
  const projectKeys = readKeysJson(projectKeysPath(cwd));
  const fromProject = projectKeys?.[ref];
  if (typeof fromProject === "string" && fromProject.length > 0) {
    return fromProject;
  }

  // 2. ~/.huko/keys.json
  const globalKeys = readKeysJson(globalKeysPath());
  const fromGlobal = globalKeys?.[ref];
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) {
    return fromGlobal;
  }

  // 3. process.env
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }

  // 4. <cwd>/.env
  const dotenv = readDotenv(path.join(cwd, ".env"));
  const fromDotenv = dotenv?.[envName];
  if (typeof fromDotenv === "string" && fromDotenv.length > 0) {
    return fromDotenv;
  }

  throw new Error(
    `No API key found for "${ref}". Set one of:\n` +
      `  - <cwd>/.huko/keys.json: { "${ref}": "..." }\n` +
      `  - ~/.huko/keys.json: { "${ref}": "..." }\n` +
      `  - env: ${envName}=...\n` +
      `  - <cwd>/.env: ${envName}=...`,
  );
}

/**
 * Map a ref name to the environment-variable name that resolves it.
 * Public so other tooling (CLI provider/keys commands, error messages,
 * docs generators) can spell out the same convention.
 */
export function envVarNameFor(ref: string): string {
  // Replace anything that's not [A-Za-z0-9] with `_` so refs like
  // "my-corp.gateway" still produce a legal env-var name.
  const sanitised = ref.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${sanitised}_API_KEY`;
}

// ─── Introspection ───────────────────────────────────────────────────────────

export type KeySourceLayer = "project" | "global" | "env" | "dotenv" | "unset";

export type KeySourceDescription = {
  /** Where the resolver finds the key now (`unset` if it can't). */
  layer: KeySourceLayer;
  /** The env-var name this ref maps to under the convention. */
  envName: string;
};

/**
 * Describe where `ref` currently resolves from WITHOUT returning the
 * value. Powers `huko keys list` so we can report status for many refs
 * without spilling secrets to stdout.
 */
export function describeKeySource(
  ref: string,
  opts: ResolveKeyOptions = {},
): KeySourceDescription {
  const cwd = opts.cwd ?? process.cwd();
  const envName = envVarNameFor(ref);

  const projectKeys = readKeysJson(projectKeysPath(cwd));
  const fromProject = projectKeys?.[ref];
  if (typeof fromProject === "string" && fromProject.length > 0) {
    return { layer: "project", envName };
  }

  const globalKeys = readKeysJson(globalKeysPath());
  const fromGlobal = globalKeys?.[ref];
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) {
    return { layer: "global", envName };
  }

  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { layer: "env", envName };
  }

  const dotenv = readDotenv(path.join(cwd, ".env"));
  const fromDotenv = dotenv?.[envName];
  if (typeof fromDotenv === "string" && fromDotenv.length > 0) {
    return { layer: "dotenv", envName };
  }

  return { layer: "unset", envName };
}

// ─── Write helpers — project layer (huko keys set / unset) ──────────────────

/**
 * Write `ref → value` into `<cwd>/.huko/keys.json`. Existing keys are
 * preserved. Auto-creates `<cwd>/.huko/`. On POSIX, chmods the file to
 * `0o600` (Windows ignores the call). Throws on I/O error.
 */
export function setProjectKey(
  ref: string,
  value: string,
  opts: ResolveKeyOptions = {},
): void {
  if (!ref || ref.trim() === "") throw new Error("setProjectKey: empty ref");
  if (!value || value.length === 0) throw new Error("setProjectKey: empty value");

  const cwd = opts.cwd ?? process.cwd();
  writeKeyToFile(projectKeysPath(cwd), ref, value);
}

/**
 * Remove `ref` from `<cwd>/.huko/keys.json`. Returns `true` if a key
 * was removed, `false` if the file was missing or didn't have it.
 */
export function unsetProjectKey(
  ref: string,
  opts: ResolveKeyOptions = {},
): boolean {
  const cwd = opts.cwd ?? process.cwd();
  return removeKeyFromFile(projectKeysPath(cwd), ref);
}

/**
 * List the refs currently present in `<cwd>/.huko/keys.json`. Returns
 * just the names (NOT values) so callers can render diagnostics
 * without re-leaking secrets. Empty array when the file is missing.
 */
export function listProjectKeyRefs(opts: ResolveKeyOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  return listKeyRefs(projectKeysPath(cwd));
}

// ─── Write helpers — global layer (huko setup / `keys set --global`) ────────

/**
 * Write `ref → value` into `~/.huko/keys.json`. Same chmod 600 + atomic
 * write semantics as the project variant. Lives once per machine; every
 * project's resolver sees it unless overridden by a project-layer entry.
 */
export function setGlobalKey(ref: string, value: string): void {
  if (!ref || ref.trim() === "") throw new Error("setGlobalKey: empty ref");
  if (!value || value.length === 0) throw new Error("setGlobalKey: empty value");
  writeKeyToFile(globalKeysPath(), ref, value);
}

export function unsetGlobalKey(ref: string): boolean {
  return removeKeyFromFile(globalKeysPath(), ref);
}

export function listGlobalKeyRefs(): string[] {
  return listKeyRefs(globalKeysPath());
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export function projectKeysPath(cwd: string): string {
  return path.join(cwd, ".huko", "keys.json");
}

export function globalKeysPath(): string {
  return path.join(os.homedir(), ".huko", "keys.json");
}

// ─── Internals ───────────────────────────────────────────────────────────────

function readKeysJson(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed JSON; treat as missing */
  }
  return null;
}

function writeKeyToFile(p: string, ref: string, value: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const existing = readKeysJson(p) ?? {};
  const next: Record<string, unknown> = { ...existing, [ref]: value };
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows / non-POSIX — best effort, keys.json is gitignored anyway. */
  }
}

function removeKeyFromFile(p: string, ref: string): boolean {
  const existing = readKeysJson(p);
  if (!existing) return false;
  if (!(ref in existing)) return false;

  const next: Record<string, unknown> = { ...existing };
  delete next[ref];

  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* see writeKeyToFile */
  }
  return true;
}

function listKeyRefs(p: string): string[] {
  const keys = readKeysJson(p);
  if (!keys) return [];
  return Object.keys(keys).filter((k) => typeof keys[k] === "string");
}

function readDotenv(p: string): Record<string, string> | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    return parseDotenv(raw);
  } catch {
    return null;
  }
}

/**
 * Minimal `.env` parser. Supports:
 *   KEY=value                   bare value (trimmed)
 *   KEY="value with spaces"     double-quoted value
 *   KEY='value'                 single-quoted value
 *   # comment                   skipped
 *   <blank line>                skipped
 *   export KEY=value            `export` prefix tolerated and stripped
 *
 * Does NOT support: variable interpolation (`$OTHER`), multiline values,
 * escape sequences inside quotes.
 */
function parseDotenv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][\w]*$/.test(key)) continue;

    let value = line.slice(eqIdx + 1).trim();

    if (!startsWithQuote(value)) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

function startsWithQuote(s: string): boolean {
  return s.startsWith('"') || s.startsWith("'");
}
