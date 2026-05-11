/**
 * tests/safety-scaffold.test.ts
 *
 * Covers `huko safety init` scaffolding and the
 * `appendRule` "always allow" persistence helper.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Register tools so the scaffold's tool-registry walk has something to enumerate.
import "../server/task/tools/index.js";
import {
  buildSafetyTemplate,
} from "../server/safety/scaffold.js";
import {
  installSafetyTemplate,
  appendRule,
} from "../server/safety/persist.js";
import { projectConfigPath, globalConfigPath } from "../server/config/writer.js";

let cwd: string;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-safety-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-safety-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── buildSafetyTemplate ───────────────────────────────────────────────────

describe("buildSafetyTemplate", () => {
  it("includes byDangerLevel with sensible defaults", () => {
    const t = buildSafetyTemplate() as Record<string, unknown>;
    assert.ok(t["byDangerLevel"], "byDangerLevel must be present");
    const lvl = t["byDangerLevel"] as Record<string, string>;
    assert.equal(lvl["safe"], "auto");
    assert.equal(lvl["moderate"], "auto");
    assert.equal(lvl["dangerous"], "prompt");
  });

  it("lists ONLY moderate/dangerous tools in toolRules (no safe tools)", () => {
    const t = buildSafetyTemplate() as Record<string, unknown>;
    const rules = t["toolRules"] as Record<string, unknown>;
    const names = Object.keys(rules);
    // Expected writable tools (moderate/dangerous).
    for (const expected of ["bash", "write_file", "edit_file", "delete_file", "move_file"]) {
      assert.ok(names.includes(expected), `expected ${expected} in template`);
    }
    // Safe tools must NOT appear.
    for (const forbidden of ["read_file", "list_dir", "grep", "glob", "web_fetch", "web_search", "plan", "message"]) {
      assert.ok(!names.includes(forbidden), `${forbidden} should not be in template`);
    }
  });

  it("each tool entry has deny / allow / requireConfirm as empty arrays", () => {
    const t = buildSafetyTemplate() as Record<string, unknown>;
    const rules = t["toolRules"] as Record<string, Record<string, unknown>>;
    const bash = rules["bash"]!;
    assert.deepEqual(bash["deny"], []);
    assert.deepEqual(bash["allow"], []);
    assert.deepEqual(bash["requireConfirm"], []);
  });

  it("ships `_comment*` keys (loader strips them on read)", () => {
    const t = buildSafetyTemplate() as Record<string, unknown>;
    assert.ok(typeof t["_comment"] === "string");
    assert.ok(typeof t["_comment_rules"] === "string");
  });
});

// ─── installSafetyTemplate ─────────────────────────────────────────────────

describe("installSafetyTemplate", () => {
  it("CREATES a new config.json when none exists (project scope)", () => {
    const result = installSafetyTemplate("project", cwd);
    assert.equal(result.kind, "created");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.ok(parsed.safety);
    assert.ok(parsed.safety.toolRules.bash);
  });

  it("CREATES into ~/.huko/config.json (global scope)", () => {
    const result = installSafetyTemplate("global", cwd);
    assert.equal(result.kind, "created");
    assert.ok(existsSync(globalConfigPath()));
  });

  it("MERGES into an existing config.json without overwriting siblings", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(projectConfigPath(cwd), JSON.stringify({ mode: "lean", task: { maxIterations: 50 } }), "utf8");

    const result = installSafetyTemplate("project", cwd);
    assert.equal(result.kind, "added");

    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    // Sibling fields preserved
    assert.equal(parsed.mode, "lean");
    assert.equal(parsed.task.maxIterations, 50);
    // Safety added
    assert.ok(parsed.safety);
  });

  it("IDEMPOTENT — second call reports already_present, doesn't touch file", () => {
    installSafetyTemplate("project", cwd);
    const before = readFileSync(projectConfigPath(cwd), "utf8");

    const result = installSafetyTemplate("project", cwd);
    assert.equal(result.kind, "already_present");

    const after = readFileSync(projectConfigPath(cwd), "utf8");
    assert.equal(after, before);
  });
});

// ─── appendRule ────────────────────────────────────────────────────────────

describe("appendRule", () => {
  it("creates safety/toolRules path on demand", () => {
    const result = appendRule("project", cwd, "bash", "allow", "ls");
    assert.equal(result.kind, "appended");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.deepEqual(parsed.safety.toolRules.bash.allow, ["ls"]);
  });

  it("appends to existing array, preserving order", () => {
    appendRule("project", cwd, "bash", "allow", "ls");
    appendRule("project", cwd, "bash", "allow", "npm install");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.deepEqual(parsed.safety.toolRules.bash.allow, ["ls", "npm install"]);
  });

  it("IDEMPOTENT — duplicate pattern is reported, not appended", () => {
    appendRule("project", cwd, "bash", "allow", "ls");
    const result = appendRule("project", cwd, "bash", "allow", "ls");
    assert.equal(result.kind, "already_present");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.deepEqual(parsed.safety.toolRules.bash.allow, ["ls"]);
  });

  it("never touches other tools or buckets", () => {
    appendRule("project", cwd, "bash", "deny", "sudo");
    appendRule("project", cwd, "write_file", "allow", "/tmp/");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.deepEqual(parsed.safety.toolRules.bash.deny, ["sudo"]);
    assert.deepEqual(parsed.safety.toolRules.write_file.allow, ["/tmp/"]);
  });
});
