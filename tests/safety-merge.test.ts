/**
 * tests/safety-merge.test.ts
 *
 * Pins the loader's special-case behavior for `safety.toolRules.*`
 * arrays — they UNION across layers (additive), unlike every other
 * array in HukoConfig which replaces.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resetConfigForTests } from "../server/config/loader.js";

let cwd: string;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-safety-merge-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-safety-merge-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  resetConfigForTests();
});

afterEach(() => {
  resetConfigForTests();
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeUser(safety: unknown): void {
  mkdirSync(join(tmpHome, ".huko"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".huko", "config.json"),
    JSON.stringify({ safety }),
    "utf8",
  );
}

function writeProject(safety: unknown): void {
  mkdirSync(join(cwd, ".huko"), { recursive: true });
  writeFileSync(
    join(cwd, ".huko", "config.json"),
    JSON.stringify({ safety }),
    "utf8",
  );
}

describe("loader — safety.toolRules union semantics", () => {
  it("project rules UNION with global (additive)", () => {
    writeUser({
      toolRules: { bash: { deny: ["sudo"] } },
    });
    writeProject({
      toolRules: { bash: { deny: ["re:^rm\\s+-rf"] } },
    });
    const cfg = loadConfig({ cwd });
    assert.deepEqual(cfg.safety.toolRules.bash!.deny, [
      "sudo",
      "re:^rm\\s+-rf",
    ]);
  });

  it("de-duplicates identical patterns across layers", () => {
    writeUser({ toolRules: { bash: { deny: ["sudo", "rm -rf"] } } });
    writeProject({ toolRules: { bash: { deny: ["sudo"] } } });
    const cfg = loadConfig({ cwd });
    assert.deepEqual(cfg.safety.toolRules.bash!.deny, ["sudo", "rm -rf"]);
  });

  it("merges different buckets independently", () => {
    writeUser({
      toolRules: { bash: { deny: ["sudo"], requireConfirm: ["re:--force"] } },
    });
    writeProject({
      toolRules: { bash: { allow: ["ls"] } },
    });
    const cfg = loadConfig({ cwd });
    const bash = cfg.safety.toolRules.bash!;
    assert.deepEqual(bash.deny, ["sudo"]);
    assert.deepEqual(bash.allow, ["ls"]);
    assert.deepEqual(bash.requireConfirm, ["re:--force"]);
  });

  it("project never silently relaxes a global deny (project cannot 'unset' via empty array)", () => {
    writeUser({ toolRules: { bash: { deny: ["sudo"] } } });
    writeProject({ toolRules: { bash: { deny: [] } } });
    const cfg = loadConfig({ cwd });
    // Global's `sudo` deny survives — project's [] just adds nothing.
    assert.deepEqual(cfg.safety.toolRules.bash!.deny, ["sudo"]);
  });

  it("byDangerLevel is REPLACE (not union) — project overrides global", () => {
    writeUser({
      byDangerLevel: { safe: "auto", moderate: "prompt", dangerous: "deny" },
    });
    writeProject({
      byDangerLevel: { safe: "auto", moderate: "auto", dangerous: "prompt" },
    });
    const cfg = loadConfig({ cwd });
    // Project values win (replace semantics).
    assert.equal(cfg.safety.byDangerLevel.moderate, "auto");
    assert.equal(cfg.safety.byDangerLevel.dangerous, "prompt");
  });

  it("missing safety in both files → defaults only (no crash)", () => {
    const cfg = loadConfig({ cwd });
    assert.ok(cfg.safety);
    assert.equal(cfg.safety.byDangerLevel.safe, "auto");
    assert.deepEqual(cfg.safety.toolRules, {});
  });

  it("`disabled: true` from any layer wins (OR across layers)", () => {
    writeUser({ toolRules: { bash: { disabled: true } } });
    const cfg = loadConfig({ cwd });
    assert.equal(cfg.safety.toolRules.bash?.disabled, true);
  });

  it("project `disabled: true` propagates even if global doesn't set it", () => {
    writeProject({ toolRules: { write_file: { disabled: true } } });
    const cfg = loadConfig({ cwd });
    assert.equal(cfg.safety.toolRules.write_file?.disabled, true);
  });

  it("`disabled: false` is treated as absent (cannot re-enable from a layer)", () => {
    writeUser({ toolRules: { bash: { disabled: true } } });
    writeProject({ toolRules: { bash: { disabled: false } } });
    const cfg = loadConfig({ cwd });
    // Lower layer disabled, higher layer's `false` doesn't cancel.
    assert.equal(cfg.safety.toolRules.bash?.disabled, true);
  });

  it("`disabled` coexists with deny/allow/require buckets", () => {
    writeUser({ toolRules: { bash: { deny: ["sudo"] } } });
    writeProject({ toolRules: { bash: { disabled: true, allow: ["ls"] } } });
    const cfg = loadConfig({ cwd });
    const bash = cfg.safety.toolRules.bash!;
    assert.equal(bash.disabled, true);
    assert.deepEqual(bash.deny, ["sudo"]);
    assert.deepEqual(bash.allow, ["ls"]);
  });
});
