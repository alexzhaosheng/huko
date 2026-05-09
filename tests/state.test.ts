/**
 * tests/state.test.ts
 *
 * `<cwd>/.huko/state.json` — atomic write-then-rename; tolerant
 * read on missing or malformed file.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getActiveSessionId,
  readCwdState,
  setActiveSessionId,
  writeCwdState,
} from "../server/cli/state.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-state-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("readCwdState", () => {
  it("returns {} when file is missing", () => {
    assert.deepEqual(readCwdState(cwd), {});
  });

  it("returns {} when file is malformed JSON", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(join(cwd, ".huko", "state.json"), "not json");
    assert.deepEqual(readCwdState(cwd), {});
  });

  it("returns {} when JSON is an array (not object)", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(join(cwd, ".huko", "state.json"), "[1,2,3]");
    assert.deepEqual(readCwdState(cwd), {});
  });

  it("returns valid state when activeSessionId is a positive integer", () => {
    writeCwdState(cwd, { activeSessionId: 42 });
    assert.deepEqual(readCwdState(cwd), { activeSessionId: 42 });
  });

  it("ignores activeSessionId when not a positive integer", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(
      join(cwd, ".huko", "state.json"),
      JSON.stringify({ activeSessionId: "not-a-number" }),
    );
    assert.deepEqual(readCwdState(cwd), {});

    writeFileSync(
      join(cwd, ".huko", "state.json"),
      JSON.stringify({ activeSessionId: -1 }),
    );
    assert.deepEqual(readCwdState(cwd), {});

    writeFileSync(
      join(cwd, ".huko", "state.json"),
      JSON.stringify({ activeSessionId: 1.5 }),
    );
    assert.deepEqual(readCwdState(cwd), {});
  });
});

describe("writeCwdState atomicity", () => {
  it("creates the .huko/ directory if absent", () => {
    assert.equal(existsSync(join(cwd, ".huko")), false);
    writeCwdState(cwd, { activeSessionId: 7 });
    assert.equal(existsSync(join(cwd, ".huko", "state.json")), true);
  });

  it("writes valid JSON for the active id", () => {
    writeCwdState(cwd, { activeSessionId: 99 });
    const raw = readFileSync(join(cwd, ".huko", "state.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), { activeSessionId: 99 });
  });

  it("clears the file (writes {}) when no active id", () => {
    writeCwdState(cwd, {});
    const raw = readFileSync(join(cwd, ".huko", "state.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), {});
  });

  it("does not leave a .tmp file behind on success", () => {
    writeCwdState(cwd, { activeSessionId: 1 });
    assert.equal(existsSync(join(cwd, ".huko", "state.json.tmp")), false);
  });

  it("repeat writes converge to last value", () => {
    writeCwdState(cwd, { activeSessionId: 1 });
    writeCwdState(cwd, { activeSessionId: 2 });
    writeCwdState(cwd, { activeSessionId: 3 });
    assert.deepEqual(readCwdState(cwd), { activeSessionId: 3 });
  });
});

describe("getActiveSessionId / setActiveSessionId", () => {
  it("getActiveSessionId returns null when nothing set", () => {
    assert.equal(getActiveSessionId(cwd), null);
  });

  it("set then get round trip", () => {
    setActiveSessionId(cwd, 12);
    assert.equal(getActiveSessionId(cwd), 12);
  });

  it("setActiveSessionId(null) clears", () => {
    setActiveSessionId(cwd, 12);
    setActiveSessionId(cwd, null);
    assert.equal(getActiveSessionId(cwd), null);
  });
});
