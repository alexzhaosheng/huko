/**
 * tests/skills-loader.test.ts
 *
 * Coverage for server/skills/index.ts — file discovery across the
 * project + user layers, both single-file and folder-style layouts,
 * the active-set helper, and graceful warn-on-missing semantics.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeSkillNames,
  listAvailableSkills,
  loadActiveSkills,
  loadSkill,
} from "../server/skills/index.js";

let cwd: string;
let tmpHome: string;
let savedHome: string | undefined;
let stderrWrite: typeof process.stderr.write;
let stderrCaptured: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-skills-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-skills-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;

  // Capture stderr so warn-paths can be asserted without leaking noise.
  stderrCaptured = [];
  stderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stderrCaptured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
});

afterEach(() => {
  (process.stderr.write as unknown) = stderrWrite;
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function writeProjectSkill(name: string, body: string): void {
  const dir = join(cwd, ".huko", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, "utf8");
}

function writeUserSkill(name: string, body: string): void {
  const dir = join(tmpHome, ".huko", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, "utf8");
}

function writeProjectFolderSkill(name: string, body: string): void {
  const dir = join(cwd, ".huko", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
}

const SAMPLE_BODY = `---
description: do the thing
---

When asked, do the thing.`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("loadSkill — layer precedence + layout shapes", () => {
  it("loads a single-file project skill", async () => {
    writeProjectSkill("deploy", SAMPLE_BODY);
    const skill = await loadSkill("deploy", cwd);
    assert.equal(skill.name, "deploy");
    assert.equal(skill.source, "project");
    assert.equal(skill.frontmatter.description, "do the thing");
    assert.ok(skill.body.includes("do the thing"));
  });

  it("loads a folder-style SKILL.md", async () => {
    writeProjectFolderSkill("deploy", SAMPLE_BODY);
    const skill = await loadSkill("deploy", cwd);
    assert.equal(skill.name, "deploy");
    assert.ok(skill.path.endsWith(join("deploy", "SKILL.md")));
  });

  it("project layer wins over user layer for the same name", async () => {
    writeUserSkill("deploy", "---\ndescription: user\n---\nuser body");
    writeProjectSkill("deploy", "---\ndescription: project\n---\nproject body");
    const skill = await loadSkill("deploy", cwd);
    assert.equal(skill.source, "project");
    assert.equal(skill.frontmatter.description, "project");
  });

  it("falls through to user layer when project has no copy", async () => {
    writeUserSkill("deploy", SAMPLE_BODY);
    const skill = await loadSkill("deploy", cwd);
    assert.equal(skill.source, "user");
  });

  it("throws with searched paths listed when the skill is missing", async () => {
    await assert.rejects(
      () => loadSkill("nonexistent", cwd),
      /Skill "nonexistent" not found.*Searched/s,
    );
  });

  it("treats unknown frontmatter keys as forward-compatible (ignored)", async () => {
    writeProjectSkill(
      "deploy",
      `---
description: x
allowed-tools: [bash, write_file]
model: claude-opus
---

body`,
    );
    const skill = await loadSkill("deploy", cwd);
    assert.equal(skill.frontmatter.description, "x");
  });
});

describe("listAvailableSkills", () => {
  it("dedupes names across layers and surfaces source=project for shadowed entries", async () => {
    writeUserSkill("alpha", SAMPLE_BODY);
    writeUserSkill("beta", SAMPLE_BODY);
    writeProjectSkill("alpha", SAMPLE_BODY);

    const list = await listAvailableSkills(cwd);
    assert.deepEqual(
      list.map((s) => `${s.name}@${s.source}`),
      ["alpha@project", "beta@user"],
    );
  });

  it("discovers both single-file and folder layouts within one layer", async () => {
    writeProjectSkill("single", SAMPLE_BODY);
    writeProjectFolderSkill("foldered", SAMPLE_BODY);
    const names = (await listAvailableSkills(cwd)).map((s) => s.name);
    assert.deepEqual(names, ["foldered", "single"]);
  });

  it("ignores stray README.md or directories without SKILL.md", async () => {
    const dir = join(cwd, ".huko", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# pile of notes", "utf8");
    mkdirSync(join(dir, "empty-folder"), { recursive: true });
    const list = await listAvailableSkills(cwd);
    assert.deepEqual(list, []);
  });

  it("returns empty when neither directory exists", async () => {
    const list = await listAvailableSkills(cwd);
    assert.deepEqual(list, []);
  });
});

describe("activeSkillNames", () => {
  it("returns only entries with enabled:true, sorted", () => {
    const names = activeSkillNames({
      foo: { enabled: true },
      bar: { enabled: false },
      baz: { enabled: true },
      qux: {},
    });
    assert.deepEqual(names, ["baz", "foo"]);
  });

  it("handles undefined config", () => {
    assert.deepEqual(activeSkillNames(undefined), []);
  });
});

describe("loadActiveSkills — warn-skip on missing", () => {
  it("loads existing skills and warns on missing ones without throwing", async () => {
    writeProjectSkill("present", SAMPLE_BODY);
    const skills = await loadActiveSkills(
      { present: { enabled: true }, missing: { enabled: true } },
      cwd,
    );
    assert.deepEqual(skills.map((s) => s.name), ["present"]);
    const warnings = stderrCaptured.join("");
    assert.match(warnings, /skill "missing" enabled but not loadable/);
  });
});
