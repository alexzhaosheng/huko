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
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

  const entries = loadVault();
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
  const entries = loadVault();
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
  writeFileSync(p, JSON.stringify({ entries: sorted }, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    // Windows / non-POSIX FS — best effort. The file is auto-gitignored
    // (see SqliteSessionPersistence's DEFAULT_GITIGNORE).
  }
}
