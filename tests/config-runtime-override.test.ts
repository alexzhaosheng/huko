/**
 * tests/config-runtime-override.test.ts
 *
 * Exercises the loader's runtime-override accumulator —
 * `extendExplicitOverride(partial)` deep-merges into the explicit layer
 * without wiping prior contributors, while `loadConfig({explicit:X})`
 * replaces wholesale. This is the seam that lets CLI flags (set once at
 * bootstrap) coexist with chat slash commands (mutate mid-process).
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extendExplicitOverride,
  getConfig,
  loadConfig,
  resetConfigForTests,
} from "../server/config/loader.js";

let cwd: string;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-rt-override-cwd-"));
  tmpHome = mkdtempSync(join(tmpdir(), "huko-rt-override-home-"));
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

describe("loader — runtime override accumulator", () => {
  it("loadConfig({explicit:X}) applies X as the runtime override", () => {
    loadConfig({
      cwd,
      explicit: { compaction: { thresholdRatio: 0.3, targetRatio: 0.1, charsPerToken: 4 } },
    });
    assert.equal(getConfig().compaction.thresholdRatio, 0.3);
    assert.equal(getConfig().compaction.targetRatio, 0.1);
  });

  it("extendExplicitOverride merges on top of a prior loadConfig explicit", () => {
    loadConfig({
      cwd,
      explicit: { compaction: { thresholdRatio: 0.4, targetRatio: 0.2, charsPerToken: 4 } },
    });
    extendExplicitOverride({ task: { maxIterations: 99 } as never });
    // Prior compaction override survives the new field's accumulation.
    assert.equal(getConfig().compaction.thresholdRatio, 0.4);
    assert.equal(getConfig().task.maxIterations, 99);
  });

  it("repeated extendExplicitOverride deep-merges per-field", () => {
    extendExplicitOverride({
      compaction: { thresholdRatio: 0.3, targetRatio: 0.1, charsPerToken: 4 },
    });
    // Only thresholdRatio updated; targetRatio inherits from prior override.
    extendExplicitOverride({
      compaction: { thresholdRatio: 0.2 } as never,
    });
    assert.equal(getConfig().compaction.thresholdRatio, 0.2);
    assert.equal(getConfig().compaction.targetRatio, 0.1);
  });

  it("loadConfig({explicit:X}) REPLACES whatever extendExplicitOverride had accumulated", () => {
    extendExplicitOverride({ task: { maxIterations: 99 } as never });
    loadConfig({
      cwd,
      explicit: { compaction: { thresholdRatio: 0.5, targetRatio: 0.3, charsPerToken: 4 } },
    });
    // The earlier task override is gone — loadConfig with explicit
    // wholesale-replaces the runtime overlay.
    assert.notEqual(getConfig().task.maxIterations, 99);
    assert.equal(getConfig().compaction.thresholdRatio, 0.5);
  });

  it("resetConfigForTests clears the runtime overlay", () => {
    extendExplicitOverride({
      compaction: { thresholdRatio: 0.3, targetRatio: 0.1, charsPerToken: 4 },
    });
    assert.equal(getConfig().compaction.thresholdRatio, 0.3);
    resetConfigForTests();
    loadConfig({ cwd });
    // After reset, the default 0.7 is back.
    assert.equal(getConfig().compaction.thresholdRatio, 0.7);
  });
});
