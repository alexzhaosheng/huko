/**
 * server/security/vault.ts
 *
 * The local password vault — Layer 3 of huko's redaction system.
 *
 * Concept: the user explicitly registers strings that must NEVER reach
 * an LLM provider. The scrubber consults this vault on every outbound
 * message and replaces any literal occurrence with a placeholder
 * (`[REDACTED:<name>]`). The session-substitution table records the
 * mapping so the inverse direction (placeholder → raw) works for tool
 * calls the LLM emits using the placeholder.
 *
 * Storage: one JSON file at `~/.huko/vault.json` (chmod 600). Vault is
 * GLOBAL only — secrets are personal-identity scoped, not project
 * scoped. Project-specific redactions belong in the regex layer
 * (config.json `safety.redactPatterns`), not here.
 *
 * Schema:
 *   {
 *     "entries": [
 *       { "name": "github-token", "value": "ghp_xxx...", "addedAt": 1700000000000 },
 *       ...
 *     ]
 *   }
 *
 * Design rules:
 *   - **Min length 8**: refuse to add anything shorter, otherwise the
 *     scrubber would create false positives all over normal text.
 *   - **Names are lowercase identifiers**: `[a-z0-9][a-z0-9_-]*`. They
 *     become placeholder labels (`[REDACTED:my-token]`) so the LLM has
 *     a stable referent.
 *   - **list() never returns values**: only metadata (name, length,
 *     addedAt). Use `get(name)` for the value, and only the scrubber +
 *     `huko vault test` should call it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type VaultEntry = {
  name: string;
  value: string;
  addedAt: number;
};

export type VaultListing = {
  name: string;
  length: number;
  addedAt: number;
};

export const MIN_VAULT_VALUE_LENGTH = 8;
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// ─── Path ───────────────────────────────────────────────────────────────────

export function vaultPath(): string {
  return path.join(os.homedir(), ".huko", "vault.json");
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Load every vault entry. Returns `[]` if the file is missing or
 * malformed (intentionally permissive — the scrubber should never
 * crash because the vault file got corrupted).
 */
export function loadVault(): VaultEntry[] {
  const p = vaultPath();
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    const out: VaultEntry[] = [];
    for (const e of entries) {
      if (
        e !== null &&
        typeof e === "object" &&
        typeof (e as VaultEntry).name === "string" &&
        typeof (e as VaultEntry).value === "string" &&
        typeof (e as VaultEntry).addedAt === "number"
      ) {
        out.push(e as VaultEntry);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Get a single entry's value by name, or null if not present. */
export function getVaultValue(name: string): string | null {
  for (const e of loadVault()) {
    if (e.name === name) return e.value;
  }
  return null;
}

/** Metadata for every entry — safe to display (no values). */
export function listVaultEntries(): VaultListing[] {
  return loadVault()
    .map((e) => ({ name: e.name, length: e.value.length, addedAt: e.addedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Write ──────────────────────────────────────────────────────────────────

export type AddVaultResult =
  | { kind: "added" }
  | { kind: "replaced"; previousLength: number };

/**
 * Insert or update an entry. Throws on:
 *   - empty / non-conforming name
 *   - value shorter than MIN_VAULT_VALUE_LENGTH
 *   - existing vault.json present but unparseable (refuse to clobber)
 */
export function addVaultEntry(name: string, value: string): AddVaultResult {
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(
      `vault: name must match ${VAULT_NAME_RE} (got: "${name}")`,
    );
  }
  if (value.length < MIN_VAULT_VALUE_LENGTH) {
    throw new Error(
      `vault: value must be at least ${MIN_VAULT_VALUE_LENGTH} characters ` +
        `(got ${value.length}). Short strings cause too many false positives ` +
        `during outbound scrubbing.`,
    );
  }

  // Use the strict reader so a corrupt vault.json blocks the write
  // rather than silently overwriting it with a one-entry list.
  const entries = readVaultStrictForWrite();
  const idx = entries.findIndex((e) => e.name === name);
  let result: AddVaultResult;
  if (idx >= 0) {
    const previousLength = entries[idx]!.value.length;
    entries[idx] = { name, value, addedAt: Date.now() };
    result = { kind: "replaced", previousLength };
  } else {
    entries.push({ name, value, addedAt: Date.now() });
    result = { kind: "added" };
  }

  writeVault(entries);
  return result;
}

/** Remove by name. Returns true if anything was actually removed. */
export function removeVaultEntry(name: string): boolean {
  // Same strict-read protection as addVaultEntry — never overwrite a
  // corrupt vault.json with a smaller list.
  const entries = readVaultStrictForWrite();
  const next = entries.filter((e) => e.name !== name);
  if (next.length === entries.length) return false;
  writeVault(next);
  return true;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function writeVault(entries: VaultEntry[]): void {
  const p = vaultPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  // Atomic + 0o600 in a single open() — no permission race, no
  // truncated file if we crash mid-write. See atomic-write.ts.
  atomicWriteFile(p, JSON.stringify({ entries: sorted }, null, 2) + "\n", 0o600);
}

/**
 * Read vault.json for a WRITE path — throw rather than swallow errors.
 *
 * `loadVault()` is intentionally permissive: the scrubber is on the hot
 * path of every outbound message, so a corrupted vault should never
 * crash a task. But that permissiveness is dangerous in the write
 * path: addVaultEntry / removeVaultEntry would silently load `[]` from
 * a broken file, mutate the empty list, and overwrite the original —
 * data loss with no warning.
 *
 * This variant differs from loadVault in exactly one way: if vault.json
 * exists with non-empty contents and isn't parseable as
 * `{ entries: [...] }`, it throws with a message pointing the operator
 * at the file. Individual malformed entry objects are still skipped
 * silently (they don't tell us anything about the file's integrity
 * overall).
 */
function readVaultStrictForWrite(): VaultEntry[] {
  const p = vaultPath();
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  if (raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `vault: existing ${p} is not valid JSON (${msg}). Refusing to ` +
        `overwrite — inspect or remove the file manually before adding ` +
        `new entries. (If the file is recoverable, fix the JSON and rerun.)`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `vault: ${p} is not an object with the expected { entries: [...] } shape. ` +
        `Refusing to overwrite.`,
    );
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(
      `vault: ${p}.entries is not an array. Refusing to overwrite.`,
    );
  }
  const out: VaultEntry[] = [];
  for (const e of entries) {
    if (
      e !== null &&
      typeof e === "object" &&
      typeof (e as VaultEntry).name === "string" &&
      typeof (e as VaultEntry).value === "string" &&
      typeof (e as VaultEntry).addedAt === "number"
    ) {
      out.push(e as VaultEntry);
    }
  }
  return out;
}
