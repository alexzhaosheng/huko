/**
 * tests/redaction.test.ts
 *
 * Pins the three-layer redaction system:
 *
 *   Layer 2 (regex)  — built-in patterns scrub well-known secret shapes.
 *   Layer 3 (vault)  — exact-string redactions sourced from
 *                       ~/.huko/vault.json.
 *   substitution table — per-session map (placeholder ↔ raw) so tool
 *                        execution can expand placeholders back to
 *                        real values without ever sending raw to LLM.
 *
 * These tests use MemorySessionPersistence so we don't touch real
 * SQLite DBs, and override $HOME so vault writes go to a tmp dir.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemorySessionPersistence } from "../server/persistence/memory.js";
import {
  expandPlaceholders,
  expandPlaceholdersDeep,
  scrubAndRecord,
} from "../server/security/scrubber.js";
import {
  addVaultEntry,
  loadVault,
  removeVaultEntry,
  MIN_VAULT_VALUE_LENGTH,
} from "../server/security/vault.js";

let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "huko-vault-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function ctx(persistence = new MemorySessionPersistence()) {
  return { persistence, sessionId: 1, sessionType: "chat" as const };
}

// ─── Vault CRUD ─────────────────────────────────────────────────────────────

describe("vault — CRUD + min length", () => {
  it("starts empty in a fresh HOME", () => {
    assert.deepEqual(loadVault(), []);
  });

  it("adds an entry and reads it back", () => {
    const r = addVaultEntry("github-token", "ghp_abcdefghijklmnop");
    assert.equal(r.kind, "added");
    const all = loadVault();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, "github-token");
    assert.equal(all[0]!.value, "ghp_abcdefghijklmnop");
  });

  it("rejects short values", () => {
    assert.throws(
      () => addVaultEntry("short", "abc"),
      /at least 8 characters/,
    );
    assert.throws(
      () => addVaultEntry("almost", "1234567"),
      new RegExp(`at least ${MIN_VAULT_VALUE_LENGTH} characters`),
    );
  });

  it("replaces an existing entry by name", () => {
    addVaultEntry("token", "ghp_first1234567890");
    const r = addVaultEntry("token", "ghp_second12345678901");
    assert.equal(r.kind, "replaced");
    assert.equal(r.kind === "replaced" && r.previousLength, "ghp_first1234567890".length);
    assert.equal(loadVault()[0]!.value, "ghp_second12345678901");
  });

  it("removes by name", () => {
    addVaultEntry("token", "ghp_abcdefghijklmnop");
    assert.equal(removeVaultEntry("token"), true);
    assert.equal(removeVaultEntry("token"), false);
    assert.deepEqual(loadVault(), []);
  });

  it("rejects malformed names", () => {
    assert.throws(() => addVaultEntry("UPPERCASE", "abcdefgh"), /name must match/);
    assert.throws(() => addVaultEntry("has space", "abcdefgh"), /name must match/);
    assert.throws(() => addVaultEntry("", "abcdefgh"), /name must match/);
  });
});

// ─── Scrubber: vault-driven ─────────────────────────────────────────────────

describe("scrubber — vault hits", () => {
  it("replaces a vault value with [REDACTED:<name>]", async () => {
    addVaultEntry("github-token", "ghp_abcdefghijklmnop");
    const c = ctx();
    const out = await scrubAndRecord(
      "Use ghp_abcdefghijklmnop to push",
      c,
    );
    assert.equal(out, "Use [REDACTED:github-token] to push");
  });

  it("records the substitution for later expansion", async () => {
    addVaultEntry("github-token", "ghp_abcdefghijklmnop");
    const c = ctx();
    await scrubAndRecord("ghp_abcdefghijklmnop", c);
    const recovered = await c.persistence.substitutions.lookupByPlaceholder(
      c.sessionId, c.sessionType, "github-token",
    );
    assert.equal(recovered, "ghp_abcdefghijklmnop");
  });

  it("longest-first: a longer secret containing a shorter one is matched as the longer", async () => {
    // Two vault entries where one's value is a prefix of another.
    // Without longest-first sorting, the short one would consume the
    // first chars of the long one and break redaction.
    addVaultEntry("short", "abcdefghij");
    addVaultEntry("longer", "abcdefghijklmnop");
    const c = ctx();
    const out = await scrubAndRecord("abcdefghijklmnop and abcdefghij separately", c);
    // The full longer string gets the "longer" placeholder; the bare
    // "abcdefghij" elsewhere uses "short".
    assert.equal(out, "[REDACTED:longer] and [REDACTED:short] separately");
  });

  it("idempotent: same secret in two calls → same placeholder", async () => {
    addVaultEntry("token", "ghp_abcdefghijklmnop");
    const c = ctx();
    const a = await scrubAndRecord("ghp_abcdefghijklmnop", c);
    const b = await scrubAndRecord("ghp_abcdefghijklmnop again", c);
    assert.equal(a, "[REDACTED:token]");
    assert.equal(b, "[REDACTED:token] again");
  });
});

// ─── Scrubber: regex (built-in) ─────────────────────────────────────────────

describe("scrubber — built-in regex hits", () => {
  it("redacts an OpenAI key", async () => {
    const c = ctx();
    const out = await scrubAndRecord(
      "key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      c,
    );
    assert.match(out, /\[REDACTED:secret-\d+\]/);
    assert.ok(!out.includes("sk-proj-abcdefghij"));
  });

  it("redacts a GitHub PAT", async () => {
    const c = ctx();
    // gh_ + p/o/u/s/r + _ + 36 base62 chars
    const fake = "ghp_" + "a".repeat(36);
    const out = await scrubAndRecord(`token: ${fake}`, c);
    assert.match(out, /\[REDACTED:secret-\d+\]/);
    assert.ok(!out.includes(fake));
  });

  it("redacts a JWT", async () => {
    const c = ctx();
    const jwt = "eyJ" + "a".repeat(20) + "." + "b".repeat(20) + "." + "c".repeat(20);
    const out = await scrubAndRecord(`Authorization: Bearer ${jwt}`, c);
    assert.match(out, /\[REDACTED:secret-\d+\]/);
    assert.ok(!out.includes(jwt));
  });

  it("redacts a PEM private key (multi-line)", async () => {
    const c = ctx();
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEowIBAAKCAQEA...\n" +
      "lots of base64\n" +
      "-----END RSA PRIVATE KEY-----";
    const out = await scrubAndRecord(`my key:\n${pem}\nend`, c);
    assert.ok(out.includes("[REDACTED:"));
    assert.ok(!out.includes("MIIEowIBAAKCAQEA"));
  });

  it("idempotent across calls — same regex match → same placeholder", async () => {
    const c = ctx();
    const key = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const a = await scrubAndRecord(`use ${key}`, c);
    const b = await scrubAndRecord(`reuse ${key} please`, c);
    // Extract the placeholder from each call and compare.
    const phA = a.match(/\[REDACTED:secret-\d+\]/)?.[0];
    const phB = b.match(/\[REDACTED:secret-\d+\]/)?.[0];
    assert.ok(phA && phB && phA === phB, `expected same placeholder, got ${phA} vs ${phB}`);
  });

  it("does NOT redact a non-secret-shaped string", async () => {
    const c = ctx();
    const out = await scrubAndRecord("hello world, this is just text", c);
    assert.equal(out, "hello world, this is just text");
  });
});

// ─── Expand placeholders (the inverse direction) ───────────────────────────

describe("scrubber — expandPlaceholders", () => {
  it("expands a known placeholder back to its raw value", async () => {
    addVaultEntry("token", "ghp_abcdefghijklmnop");
    const c = ctx();
    await scrubAndRecord("ghp_abcdefghijklmnop", c);
    const expanded = await expandPlaceholders("git push using [REDACTED:token]", c);
    assert.equal(expanded, "git push using ghp_abcdefghijklmnop");
  });

  it("leaves unknown placeholders verbatim (never crashes)", async () => {
    const c = ctx();
    const expanded = await expandPlaceholders("nothing matches [REDACTED:never-seen]", c);
    assert.equal(expanded, "nothing matches [REDACTED:never-seen]");
  });

  it("expandPlaceholdersDeep walks objects + arrays", async () => {
    addVaultEntry("token", "ghp_abcdefghijklmnop");
    const c = ctx();
    await scrubAndRecord("ghp_abcdefghijklmnop", c);
    const input = {
      command: "git push https://[REDACTED:token]@github.com/repo",
      env: ["FOO=bar", "AUTH=[REDACTED:token]"],
      nested: { token: "[REDACTED:token]" },
    };
    const out = (await expandPlaceholdersDeep(input, c)) as typeof input;
    assert.ok(out.command.includes("ghp_abcdefghijklmnop"));
    assert.equal(out.env[1], "AUTH=ghp_abcdefghijklmnop");
    assert.equal(out.nested.token, "ghp_abcdefghijklmnop");
  });

  it("non-string values pass through unchanged", async () => {
    const c = ctx();
    const input = { n: 42, b: true, x: null, list: [1, 2, "[REDACTED:foo]"] };
    const out = (await expandPlaceholdersDeep(input, c)) as typeof input;
    assert.equal(out.n, 42);
    assert.equal(out.b, true);
    assert.equal(out.x, null);
    // Unknown placeholder leaves the array element verbatim.
    assert.deepEqual(out.list, [1, 2, "[REDACTED:foo]"]);
  });
});

// ─── Round-trip integration ─────────────────────────────────────────────────

describe("scrubber — round trip (LLM never sees raw, tool gets raw)", () => {
  it("user prompt → scrubbed → tool args expanded back", async () => {
    addVaultEntry("api-key", "sk-real-key-1234567890");
    const c = ctx();

    // 1. User types a prompt with the raw secret.
    const userTyped = "use sk-real-key-1234567890 to call the API";
    const sentToLLM = await scrubAndRecord(userTyped, c);
    assert.equal(sentToLLM, "use [REDACTED:api-key] to call the API");

    // 2. LLM responds with a tool call referencing the placeholder.
    const llmToolArgs = {
      url: "https://api.example.com",
      headers: { Authorization: "Bearer [REDACTED:api-key]" },
    };

    // 3. Tool execution expands the placeholder back to the raw key.
    const runtimeArgs = (await expandPlaceholdersDeep(
      llmToolArgs,
      c,
    )) as typeof llmToolArgs;
    assert.equal(
      runtimeArgs.headers.Authorization,
      "Bearer sk-real-key-1234567890",
    );
  });

  it("session isolation: substitutions don't bleed between sessions", async () => {
    addVaultEntry("token", "ghp_abcdefghijklmnop");

    const persistence = new MemorySessionPersistence();
    const ctxA = { persistence, sessionId: 1, sessionType: "chat" as const };
    const ctxB = { persistence, sessionId: 2, sessionType: "chat" as const };

    await scrubAndRecord("ghp_abcdefghijklmnop", ctxA);

    // Session B doesn't know about A's substitutions.
    const recoveredB = await persistence.substitutions.lookupByPlaceholder(
      ctxB.sessionId, ctxB.sessionType, "token",
    );
    assert.equal(recoveredB, null);

    // But session A still does.
    const recoveredA = await persistence.substitutions.lookupByPlaceholder(
      ctxA.sessionId, ctxA.sessionType, "token",
    );
    assert.equal(recoveredA, "ghp_abcdefghijklmnop");
  });
});
