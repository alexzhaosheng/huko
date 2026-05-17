/**
 * tests/compaction-resolver.test.ts
 *
 * Coverage for server/config/compaction.ts — the function that turns
 * (HukoConfig.compaction, model context window) into the live ratios
 * the kernel actually uses. The five presets + "max", the custom
 * escape hatch, the clamp behaviour on small windows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCompaction, ratioForLevel } from "../server/config/compaction.js";
import type { HukoConfig } from "../server/config/types.js";

const BASE: HukoConfig["compaction"] = { level: "standard", charsPerToken: 4 };

function cfg(over: Partial<HukoConfig["compaction"]> = {}): HukoConfig["compaction"] {
  return { ...BASE, ...over };
}

describe("resolveCompaction — preset levels", () => {
  it("standard on 200k → 32% (64k / 200k)", () => {
    const r = resolveCompaction(cfg({ level: "standard" }), 200_000);
    assert.equal(r.display, "standard");
    assert.ok(Math.abs(r.thresholdRatio - 0.32) < 0.005, `got ${r.thresholdRatio}`);
    assert.ok(r.targetRatio < r.thresholdRatio, "target stays below threshold");
  });

  it("concise on 1M → 3.2% (32k / 1M)", () => {
    const r = resolveCompaction(cfg({ level: "concise" }), 1_000_000);
    assert.equal(r.display, "concise");
    assert.ok(Math.abs(r.thresholdRatio - 0.032) < 0.002, `got ${r.thresholdRatio}`);
  });

  it("max → 0.95 regardless of window", () => {
    assert.equal(resolveCompaction(cfg({ level: "max" }), 200_000).thresholdRatio, 0.95);
    assert.equal(resolveCompaction(cfg({ level: "max" }), 1_000_000).thresholdRatio, 0.95);
  });

  it("clamps to 0.95 when level target exceeds the window", () => {
    // large = 256k target, 200k window → clamps to 0.95
    const r = resolveCompaction(cfg({ level: "large" }), 200_000);
    assert.equal(r.thresholdRatio, 0.95);
    assert.equal(r.display, "large", "display still reports the preset that was asked for");
  });

  it("display stays the level name when no custom override is present", () => {
    for (const level of ["concise", "standard", "extended", "large", "max"] as const) {
      const r = resolveCompaction(cfg({ level }), 200_000);
      assert.equal(r.display, level);
    }
  });
});

describe("resolveCompaction — custom override", () => {
  it("thresholdRatio set → display flips to 'custom' regardless of level", () => {
    const r = resolveCompaction(
      cfg({ level: "extended", thresholdRatio: 0.4 }),
      200_000,
    );
    assert.equal(r.display, "custom");
    assert.equal(r.thresholdRatio, 0.4);
  });

  it("targetRatio auto-derives to threshold - 0.2 when not explicitly set", () => {
    const r = resolveCompaction(cfg({ thresholdRatio: 0.6 }), 200_000);
    assert.ok(Math.abs(r.targetRatio - 0.4) < 1e-9, `got ${r.targetRatio}`);
  });

  it("explicit targetRatio is honoured (clamped below threshold)", () => {
    const r = resolveCompaction(
      cfg({ thresholdRatio: 0.7, targetRatio: 0.3 }),
      200_000,
    );
    assert.equal(r.targetRatio, 0.3);
  });

  it("clamps out-of-range thresholdRatio rather than throwing", () => {
    const high = resolveCompaction(cfg({ thresholdRatio: 1.5 }), 200_000);
    assert.equal(high.thresholdRatio, 0.95);
    const low = resolveCompaction(cfg({ thresholdRatio: -0.5 }), 200_000);
    assert.equal(low.thresholdRatio, 0.1);
  });
});

describe("ratioForLevel — exported helper", () => {
  it("matches resolveCompaction's preset path for the same inputs", () => {
    for (const level of ["concise", "standard", "extended", "large"] as const) {
      const ratio = ratioForLevel(level, 500_000);
      const resolved = resolveCompaction(cfg({ level }), 500_000);
      assert.equal(ratio, resolved.thresholdRatio);
    }
  });

  it("returns 0.95 for max", () => {
    assert.equal(ratioForLevel("max", 100_000), 0.95);
  });
});
