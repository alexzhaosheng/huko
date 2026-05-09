/**
 * server/security/keys.ts
 *
 * API-key resolution + write helpers. The DB never stores keys —
 * `providers.api_key_ref` holds a logical name (e.g. `"openrouter"`);
 * `resolveApiKey(ref, opts)` turns that name into the actual secret at
 * runtime via a three-layer lookup:
 *
 *   1. <cwd>/.huko/keys.json      project-local explicit (highest)
 *   2. process.env                shell / system env vars
 *   3. <cwd>/.env                 project-local dotenv (lowest)
 *
 * Naming convention for env vars: `<REF.toUpperCase()>_API_KEY`, so the
 * ref `"openrouter"` looks for `OPENROUTER_API_KEY` in env and `.env`.
 * The keys.json layer is keyed directly by ref (no transformation), so
 * `{ "openrouter": "..." }`.
 *
 * The split-from-DB design keeps `infra.db` and any project DB safe to
 * back up, share, or commit (no plaintext credentials inside). It also
 * lets the same provider definition use different keys per machine —
 * teammates on the same project pick up their own keys via env.
 *
 * Set/unset helpers (`setProjectKey`, `unsetProjectKey`) write the
 * project keys.json with `chmod 600` on Unix. They power `huko keys set`
 * etc.; the resolver itself is read-only.
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
 * spelling out the three places the user can put it.
 */
export function resolveApiKey(ref: string, opts: ResolveKeyOptions = {}): string {
  if (!ref || ref.trim() === "") {
    throw new Error("resolveApiKey called with empty ref");
  }
  const cwd = opts.cwd ?? process.cwd();
  const envName = envVarNameFor(ref);

  // 1. <cwd>/.huko/keys.json
  const projectKeys = readKeysJson(path.join(cwd, ".huko", "keys.json"));
  const fromProject = projectKeys?.[ref];
  if (typeof fromProject === "string" && fromProject.length > 0) {
    return fromProject;
  }

  // 2. process.env
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }

  // 3. <cwd>/.env
  const dotenv = readDotenv(path.join(cwd, ".env"));
  const fromDotenv = dotenv?.[envName];
  if (typeof fromDotenv === "string" && fromDotenv.length > 0) {
    return fromDotenv;
  }

  throw new Error(
    `No API key found for "${ref}". Set one of:\n` +
      `  - <cwd>/.huko/keys.json: { "${ref}": "..." }\n` +
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

export type KeySourceLayer = "project" | "env" | "dotenv" | "unset";

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

  const projectKeys = readKeysJson(path.join(cwd, ".huko", "keys.json"));
  const fromProject = projectKeys?.[ref];
  if (typeof fromProject === "string" && fromProject.length > 0) {
    return { layer: "project", envName };
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

// ─── Write helpers (CLI: huko keys set / unset) ──────────────────────────────

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
  const dir = path.join(cwd, ".huko");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "keys.json");

  const existing = readKeysJson(p) ?? {};
  const next: Record<string, unknown> = { ...existing, [ref]: value };

  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows / non-POSIX — best effort, keys.json is gitignored anyway. */
  }
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
  const p = path.join(cwd, ".huko", "keys.json");
  const existing = readKeysJson(p);
  if (!existing) return false;
  if (!(ref in existing)) return false;

  const next: Record<string, unknown> = { ...existing };
  delete next[ref];

  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* see setProjectKey */
  }
  return true;
}

/**
 * List the refs currently present in `<cwd>/.huko/keys.json`. Returns
 * just the names (NOT values) so callers can render diagnostics
 * without re-leaking secrets. Empty array when the file is missing.
 */
export function listProjectKeyRefs(opts: ResolveKeyOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const keys = readKeysJson(path.join(cwd, ".huko", "keys.json"));
  if (!keys) return [];
  return Object.keys(keys).filter((k) => typeof keys[k] === "string");
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
 * escape sequences inside quotes. If you need those, install `dotenv`
 * and replace this function — the resolveApiKey contract stays the same.
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

    // Strip an inline comment from a bare (unquoted) value: ` # ...`.
    if (!startsWithQuote(value)) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }

    // Strip surrounding quotes if matched.
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
