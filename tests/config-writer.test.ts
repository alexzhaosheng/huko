/**
 * tests/config-writer.test.ts
 *
 * Covers `server/config/writer.ts`:
 *   - path parse / get / set / unset (pure)
 *   - schema inference from DEFAULT_CONFIG
 *   - value parsing (heuristic + enum)
 *   - atomic file I/O for set/unset
 *   - rejection of unknown paths and type mismatches
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getValueByPath,
  setValueByPath,
  unsetValueByPath,
  parsePath,
  parseValue,
  inferPathSchema,
  setConfigValue,
  unsetConfigValue,
  readLayerFile,
  projectConfigPath,
  globalConfigPath,
} from "../server/config/writer.js";

let cwd: string;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-cfgw-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-cfgw-home-"));
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

// ─── pure path helpers ───────────────────────────────────────────────────────

describe("parsePath / getValueByPath / setValueByPath / unsetValueByPath", () => {
  it("parsePath splits on dots", () => {
    assert.deepEqual(parsePath("task.maxIterations"), ["task", "maxIterations"]);
    assert.deepEqual(parsePath("mode"), ["mode"]);
    assert.deepEqual(parsePath(""), []);
  });

  it("getValueByPath descends and returns undefined for missing", () => {
    const o = { a: { b: { c: 42 } } };
    assert.equal(getValueByPath(o, ["a", "b", "c"]), 42);
    assert.equal(getValueByPath(o, ["a", "b"]) instanceof Object, true);
    assert.equal(getValueByPath(o, ["a", "x"]), undefined);
    assert.equal(getValueByPath(o, ["x"]), undefined);
  });

  it("setValueByPath sets without mutating input", () => {
    const o = { a: { b: 1 } };
    const out = setValueByPath(o, ["a", "b"], 2);
    assert.equal(o.a.b, 1, "input must not be mutated");
    assert.equal(getValueByPath(out, ["a", "b"]), 2);
  });

  it("setValueByPath creates intermediate keys when missing", () => {
    const out = setValueByPath({}, ["x", "y", "z"], "hi");
    assert.equal(getValueByPath(out, ["x", "y", "z"]), "hi");
  });

  it("unsetValueByPath removes the leaf and leaves siblings intact", () => {
    const o = { a: { b: 1, c: 2 }, d: 3 };
    const out = unsetValueByPath(o, ["a", "b"]);
    assert.equal(getValueByPath(out, ["a", "b"]), undefined);
    assert.equal(getValueByPath(out, ["a", "c"]), 2);
    assert.equal(getValueByPath(out, ["d"]), 3);
    // input untouched
    assert.equal(o.a.b, 1);
  });

  it("unsetValueByPath is a no-op when path is absent", () => {
    const o = { a: 1 };
    const out = unsetValueByPath(o, ["b", "c"]);
    assert.equal(out, o, "should return the same reference");
  });
});

// ─── schema inference ───────────────────────────────────────────────────────

describe("inferPathSchema", () => {
  it("infers leaf type for known string field", () => {
    const s = inferPathSchema("daemon.host");
    assert.equal(s.kind, "leaf");
    if (s.kind === "leaf") assert.equal(s.type, "string");
  });

  it("infers leaf type for known number field", () => {
    const s = inferPathSchema("task.maxIterations");
    assert.equal(s.kind, "leaf");
    if (s.kind === "leaf") assert.equal(s.type, "number");
  });

  it("tags enum paths with their allowed values", () => {
    const s = inferPathSchema("mode");
    assert.equal(s.kind, "leaf");
    if (s.kind !== "leaf") return;
    assert.equal(s.type, "string");
    assert.deepEqual([...(s.enum ?? [])], ["lean", "full"]);
  });

  it("rejects unknown paths", () => {
    assert.equal(inferPathSchema("nonsense").kind, "unknown_path");
    assert.equal(inferPathSchema("task.bogus").kind, "unknown_path");
  });

  it("reports object paths as not_a_leaf", () => {
    assert.equal(inferPathSchema("task").kind, "not_a_leaf");
    assert.equal(inferPathSchema("tools.webFetch").kind, "not_a_leaf");
  });
});

// ─── value parsing ──────────────────────────────────────────────────────────

describe("parseValue", () => {
  it("parses booleans (case-insensitive, no cross-type coercion)", () => {
    assert.deepEqual(parseValue("true", { type: "boolean" }), { ok: true, value: true });
    assert.deepEqual(parseValue("FALSE", { type: "boolean" }), { ok: true, value: false });
    const r = parseValue("1", { type: "boolean" });
    assert.equal(r.ok, false);
  });

  it("parses numbers and rejects non-finite", () => {
    assert.deepEqual(parseValue("42", { type: "number" }), { ok: true, value: 42 });
    assert.deepEqual(parseValue("0.5", { type: "number" }), { ok: true, value: 0.5 });
    assert.deepEqual(parseValue("-3", { type: "number" }), { ok: true, value: -3 });
    assert.equal(parseValue("nope", { type: "number" }).ok, false);
    assert.equal(parseValue("", { type: "number" }).ok, false);
  });

  it("strings pass through verbatim by default", () => {
    assert.deepEqual(parseValue("hello", { type: "string" }), { ok: true, value: "hello" });
  });

  it("enforces enum membership when schema lists one", () => {
    const enum_ = ["lean", "full"] as const;
    assert.deepEqual(parseValue("lean", { type: "string", enum: enum_ }), {
      ok: true,
      value: "lean",
    });
    const bad = parseValue("aggressive", { type: "string", enum: enum_ });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error, /lean.*full/);
  });
});

// ─── setConfigValue / unsetConfigValue (file I/O) ───────────────────────────

describe("setConfigValue + unsetConfigValue", () => {
  it("writes mode=lean to ~/.huko/config.json (global scope)", () => {
    const r = setConfigValue({ path: "mode", value: "lean", scope: "global", cwd });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.next, "lean");
    assert.equal(r.previous, undefined);
    assert.equal(r.filePath, globalConfigPath());

    const onDisk = readLayerFile(r.filePath);
    assert.equal(onDisk["mode"], "lean");
  });

  it("writes mode=lean to <cwd>/.huko/config.json (project scope)", () => {
    const r = setConfigValue({ path: "mode", value: "lean", scope: "project", cwd });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.filePath, projectConfigPath(cwd));
    assert.ok(existsSync(r.filePath));
    const parsed = JSON.parse(readFileSync(r.filePath, "utf8"));
    assert.equal(parsed.mode, "lean");
  });

  it("preserves sibling fields when writing one path", () => {
    setConfigValue({ path: "mode", value: "lean", scope: "project", cwd });
    setConfigValue({ path: "task.maxIterations", value: "50", scope: "project", cwd });
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.equal(parsed.mode, "lean", "first write must survive second");
    assert.equal(parsed.task.maxIterations, 50);
  });

  it("rejects unknown paths", () => {
    const r = setConfigValue({ path: "bogus.field", value: "x", scope: "global", cwd });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /unknown config path/);
  });

  it("rejects type mismatches", () => {
    const r = setConfigValue({ path: "task.maxIterations", value: "abc", scope: "global", cwd });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /expected a number/);
  });

  it("rejects out-of-enum values", () => {
    const r = setConfigValue({ path: "mode", value: "hyper", scope: "global", cwd });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /lean.*full/);
  });

  it("unsetConfigValue removes the field and reports prior value", () => {
    setConfigValue({ path: "mode", value: "lean", scope: "project", cwd });
    const r = unsetConfigValue({ path: "mode", scope: "project", cwd });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.removed, true);
    assert.equal(r.previous, "lean");
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), "utf8"));
    assert.equal(parsed.mode, undefined);
  });

  it("unset reports removed=false when nothing was there", () => {
    const r = unsetConfigValue({ path: "mode", scope: "project", cwd });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.removed, false);
  });
});
