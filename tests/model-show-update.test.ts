/**
 * tests/model-show-update.test.ts
 *
 * `huko model show` and `huko model update` — the per-model inspection
 * and patch commands that complement `model add` / `model list`.
 *
 * What we cover here:
 *   - show prints all fields + reports context-window source (config vs
 *     heuristic) so the operator knows whether the value is pinned.
 *   - show returns exit 4 on unknown ref and 3 on malformed ref.
 *   - update creates an override in the chosen layer when the model
 *     was previously living only in built-in / a lower layer.
 *   - update preserves unspecified fields (patch, not replace).
 *   - update --context-window=auto clears the pin (the field is dropped
 *     from disk, so heuristic takes over again).
 *   - update --project writes to <cwd>/.huko/providers.json instead.
 *   - update with no patch flags returns exit 3 (don't silently
 *     rewrite the file).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelShowCommand,
  modelUpdateCommand,
} from "../server/cli/commands/model.js";

// ─── IO capture + HOME isolation ────────────────────────────────────────────

let cwd: string;
let tmpHome: string;
let savedHome: string | undefined;
let savedUserprofile: string | undefined;
let savedCwd: string;
let stdoutBuf: string;
let stderrBuf: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-model-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-model-home-"));
  savedHome = process.env["HOME"];
  savedUserprofile = process.env["USERPROFILE"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  savedCwd = process.cwd();
  process.chdir(cwd);

  stdoutBuf = "";
  stderrBuf = "";
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // Replace with capturing stubs. The signatures vary (Buffer | string,
  // callback, ...) so cast through `any` once at the boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any): boolean => {
    stdoutBuf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    stderrBuf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = origStdoutWrite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = origStderrWrite;
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedUserprofile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = savedUserprofile;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── tiny helpers ────────────────────────────────────────────────────────────

const GLOBAL_PROVIDERS_PATH = (): string =>
  join(tmpHome, ".huko", "providers.json");
const PROJECT_PROVIDERS_PATH = (): string =>
  join(cwd, ".huko", "providers.json");

function readGlobalFile(): {
  models?: Array<{
    providerName: string;
    modelId: string;
    displayName: string;
    defaultThinkLevel?: string;
    defaultToolCallMode?: string;
    contextWindow?: number;
  }>;
  providers?: unknown[];
  disabledModels?: Array<{ providerName: string; modelId: string }>;
} {
  const p = GLOBAL_PROVIDERS_PATH();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

// A built-in we can rely on existing: every fresh huko ships with
// `anthropic/claude-sonnet-4-6` in BUILTIN_MODELS.
const BUILTIN_REF = "anthropic/claude-sonnet-4-6";

// ─── show ────────────────────────────────────────────────────────────────────

describe("modelShowCommand", () => {
  it("prints a JSON payload for a built-in model with heuristic context window", async () => {
    const rc = await modelShowCommand({ ref: BUILTIN_REF, format: "json" });
    assert.equal(rc, 0);
    const payload = JSON.parse(stdoutBuf);
    assert.equal(payload.ref, BUILTIN_REF);
    assert.equal(payload.providerName, "anthropic");
    assert.equal(payload.modelId, "claude-sonnet-4-6");
    assert.equal(payload.source, "builtin");
    assert.equal(payload.contextWindowSource, "heuristic");
    assert.equal(payload.contextWindowOverride, null);
    assert.ok(payload.contextWindow > 0, "effective context window should be > 0");
    assert.ok(payload.provider, "provider sub-record present");
    assert.equal(payload.provider.name, "anthropic");
  });

  it("reports contextWindowSource=config when the model pins it via update", async () => {
    // First override the built-in via update — the show command should
    // see the pinned value the next time.
    const ru = await modelUpdateCommand({
      ref: BUILTIN_REF,
      contextWindow: 50_000,
    });
    assert.equal(ru, 0);
    stdoutBuf = ""; // reset capture before the read call

    const rc = await modelShowCommand({ ref: BUILTIN_REF, format: "json" });
    assert.equal(rc, 0);
    const payload = JSON.parse(stdoutBuf);
    assert.equal(payload.contextWindowSource, "config");
    assert.equal(payload.contextWindowOverride, 50_000);
    assert.equal(payload.contextWindow, 50_000);
    assert.equal(payload.source, "global");
  });

  it("exit 4 when the ref doesn't match any known model", async () => {
    const rc = await modelShowCommand({
      ref: "anthropic/no-such-model",
      format: "json",
    });
    assert.equal(rc, 4);
    assert.match(stderrBuf, /not found/);
    assert.equal(stdoutBuf, "");
  });

  it("exit 3 when the ref is malformed (missing separator)", async () => {
    const rc = await modelShowCommand({ ref: "no-slash-anywhere", format: "json" });
    assert.equal(rc, 3);
    assert.match(stderrBuf, /invalid model ref/);
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("modelUpdateCommand", () => {
  it("creates a global override for a built-in when context-window is pinned", async () => {
    const rc = await modelUpdateCommand({
      ref: BUILTIN_REF,
      contextWindow: 128_000,
    });
    assert.equal(rc, 0);
    assert.match(stderrBuf, /updated model/);

    const file = readGlobalFile();
    assert.ok(file.models);
    const m = file.models!.find(
      (x) => x.providerName === "anthropic" && x.modelId === "claude-sonnet-4-6",
    );
    assert.ok(m, "expected the model to be written to global");
    assert.equal(m!.contextWindow, 128_000);
    // displayName + other fields should have been seeded from the
    // built-in so the override is self-contained.
    assert.ok(m!.displayName, "displayName preserved from built-in");
  });

  it("update --context-window=auto removes the pin (field dropped on disk)", async () => {
    // First pin
    await modelUpdateCommand({ ref: BUILTIN_REF, contextWindow: 64_000 });
    // Then clear
    stderrBuf = "";
    const rc = await modelUpdateCommand({
      ref: BUILTIN_REF,
      contextWindow: "auto",
    });
    assert.equal(rc, 0);
    assert.match(stderrBuf, /cleared/);
    const file = readGlobalFile();
    const m = file.models!.find(
      (x) => x.providerName === "anthropic" && x.modelId === "claude-sonnet-4-6",
    );
    assert.ok(m);
    assert.equal(
      m!.contextWindow,
      undefined,
      "contextWindow should not appear in the persisted entry",
    );
  });

  it("patch is field-scoped — unspecified fields stay as they were", async () => {
    // Establish a baseline override with a custom displayName.
    await modelUpdateCommand({
      ref: BUILTIN_REF,
      displayName: "My Renamed Model",
      contextWindow: 200_000,
    });

    // Now patch ONLY the context window. displayName must survive.
    stderrBuf = "";
    const rc = await modelUpdateCommand({
      ref: BUILTIN_REF,
      contextWindow: 100_000,
    });
    assert.equal(rc, 0);

    const file = readGlobalFile();
    const m = file.models!.find(
      (x) => x.providerName === "anthropic" && x.modelId === "claude-sonnet-4-6",
    );
    assert.equal(m!.contextWindow, 100_000);
    assert.equal(m!.displayName, "My Renamed Model");
  });

  it("--project writes to <cwd>/.huko/providers.json instead of global", async () => {
    const rc = await modelUpdateCommand({
      ref: BUILTIN_REF,
      contextWindow: 96_000,
      project: true,
    });
    assert.equal(rc, 0);
    assert.equal(
      existsSync(GLOBAL_PROVIDERS_PATH()),
      false,
      "global file should NOT have been touched",
    );
    assert.equal(existsSync(PROJECT_PROVIDERS_PATH()), true);
    const proj = JSON.parse(readFileSync(PROJECT_PROVIDERS_PATH(), "utf8"));
    const m = proj.models.find(
      (x: { providerName: string; modelId: string }) =>
        x.providerName === "anthropic" && x.modelId === "claude-sonnet-4-6",
    );
    assert.equal(m.contextWindow, 96_000);
  });

  it("exit 3 when no patch flags are given — don't rewrite to identical state", async () => {
    const rc = await modelUpdateCommand({ ref: BUILTIN_REF });
    assert.equal(rc, 3);
    assert.match(stderrBuf, /nothing to change/);
    // No file written either.
    assert.equal(existsSync(GLOBAL_PROVIDERS_PATH()), false);
  });

  it("exit 4 when the ref doesn't match any known model", async () => {
    const rc = await modelUpdateCommand({
      ref: "anthropic/no-such-model",
      contextWindow: 64_000,
    });
    assert.equal(rc, 4);
    assert.match(stderrBuf, /not found/);
  });
});
