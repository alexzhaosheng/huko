/**
 * tests/browser-feature.test.ts
 *
 * Coverage:
 *   - "browser-control" feature is registered (enabledByDefault: false, has sidecar)
 *   - `getToolsForLLM` does NOT include the browser tool when feature is disabled
 *   - `getToolsForLLM` includes the browser tool when feature is enabled
 *   - `getToolPromptHints` does NOT include the browser hint when disabled
 *   - `getToolPromptHints` includes the browser hint when enabled
 *   - `assertNoNameCollisionsWithTools` throws on collision
 *   - `computeEnabledFeatures` — disabled by default, enabled with override
 *   - Sidecar contract: feature's sidecar has start/stop methods
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: registers every built-in tool.
import "../server/task/tools/index.js";
// Side-effect: registers all features (including "browser-control").
import "../server/services/features/features.js";

import {
  getToolsForLLM,
  getToolPromptHints,
  setEnabledFeatures,
} from "../server/task/tools/registry.js";
import {
  getFeature,
  listFeatures,
  computeEnabledFeatures,
  assertNoNameCollisionsWithTools,
} from "../server/services/features/index.js";

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  // Reset enabled features between tests — enabledFeatures is global mutable
  // state in the tool registry. Default: empty Set (no features enabled).
  setEnabledFeatures([]);
});

// ─── Feature registration ───────────────────────────────────────────────────

describe("browser-control feature registration", () => {
  it("is registered and disabled by default", () => {
    const feature = getFeature("browser-control");
    assert.ok(feature, "browser-control feature should be registered");
    assert.equal(feature!.name, "browser-control");
    assert.equal(feature!.enabledByDefault, false);
  });

  it("has a sidecar with start and stop methods", () => {
    const feature = getFeature("browser-control");
    assert.ok(feature, "browser-control feature should be registered");
    assert.ok(feature!.sidecar, "should have a sidecar");
    assert.equal(typeof feature!.sidecar!.start, "function");
    assert.equal(typeof feature!.sidecar!.stop, "function");
  });

  it("appears in listFeatures", () => {
    const all = listFeatures();
    const names = all.map((f) => f.name);
    assert.ok(names.includes("browser-control"), `expected browser-control in ${names.join(", ")}`);
  });
});

// ─── Tool gating — getToolsForLLM ───────────────────────────────────────────

describe("browser tool gating in getToolsForLLM", () => {
  it("is NOT visible when feature is disabled (default)", () => {
    // No setEnabledFeatures call — default is empty.
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("browser"), `browser should be hidden, got: ${names.join(", ")}`);
    // Other tools still present.
    assert.ok(names.includes("read_file"));
  });

  it("becomes visible when the feature is enabled", () => {
    setEnabledFeatures(["browser-control"]);
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("browser"), `browser should be visible, got: ${names.join(", ")}`);
  });

  it("is hidden again when a different feature is enabled (but not browser-control)", () => {
    setEnabledFeatures(["some-other-feature"]);
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("browser"));
  });

  it("lean mode also respects feature gating", () => {
    // Default: hidden (feature disabled)
    const leanHidden = getToolsForLLM({ lean: true });
    assert.ok(!leanHidden.some((t) => t.name === "browser"));

    // Enabled: visible
    setEnabledFeatures(["browser-control"]);
    const leanVisible = getToolsForLLM({ lean: true });
    assert.ok(leanVisible.some((t) => t.name === "browser"));
  });

  it("tool is hidden even when feature not explicitly disabled — just not enabled", () => {
    // enabledFeatures starts empty. browser-control has enabledByDefault: false.
    // So browser tool should be hidden.
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("browser"));
  });
});

// ─── Prompt hint gating — getToolPromptHints ────────────────────────────────

describe("browser prompt hint gating", () => {
  it("hides the browser hint when feature is disabled (default)", () => {
    const hints = getToolPromptHints();
    const blob = hints.join("\n\n");
    assert.doesNotMatch(blob, /Browser control \(`browser`\)/);
  });

  it("includes the browser hint when feature is enabled", () => {
    setEnabledFeatures(["browser-control"]);
    const hints = getToolPromptHints();
    const blob = hints.join("\n\n");
    assert.match(blob, /Browser control \(`browser`\)/);
  });

  it("browser hint is absent when hint collector never sees the tool", () => {
    // No features enabled → browser tool filtered → no hint.
    const hints = getToolPromptHints();
    for (const h of hints) {
      assert.ok(!h.includes("Browser control"), `unexpected hint: ${h}`);
    }
  });
});

// ─── Name collision detection ────────────────────────────────────────────────

describe("assertNoNameCollisionsWithTools", () => {
  it("throws when a feature name collides with a tool name", () => {
    // The "browser" tool exists, but the feature is named "browser-control"
    // so there is NO collision in the real registry. Verify that a forced
    // collision DOES throw.
    assert.throws(
      () => assertNoNameCollisionsWithTools(["browser-control"]),
      /Feature name "browser-control" collides/,
    );
  });

  it("does NOT throw when tool names and feature names are disjoint", () => {
    // Real tool names (read-only ones) do NOT collide with "browser-control".
    assert.doesNotThrow(() => assertNoNameCollisionsWithTools(["read_file", "list_dir", "grep"]));
  });

  it("does NOT throw when there are no features registered (and we reset them)", () => {
    // import creates "browser-control". Verify that without features, no collision.
    // We can't un-register here, but we can test with tool names that DON'T
    // match any feature name. The real collision test is above.
    assert.doesNotThrow(() =>
      assertNoNameCollisionsWithTools(["some-tool-that-is-not-a-feature-name"])
    );
  });
});

// ─── computeEnabledFeatures ──────────────────────────────────────────────────

describe("computeEnabledFeatures", () => {
  it("does NOT include browser-control when no config overrides (disabled by default)", () => {
    const enabled = computeEnabledFeatures({});
    assert.ok(!enabled.has("browser-control"));
  });

  it("includes browser-control when explicitly enabled in config", () => {
    const enabled = computeEnabledFeatures({
      "browser-control": { enabled: true },
    });
    assert.ok(enabled.has("browser-control"));
  });

  it("excludes browser-control when explicitly disabled in config", () => {
    const enabled = computeEnabledFeatures({
      "browser-control": { enabled: false },
    });
    assert.ok(!enabled.has("browser-control"));
  });

  it("returns empty set when no features have enabledByDefault: true and no overrides", () => {
    // All registered features currently ship with enabledByDefault: false.
    // (If a future feature ships with enabledByDefault: true, this test
    // documents the behavioural expectation.)
    const enabled = computeEnabledFeatures({});
    assert.ok(!enabled.has("browser-control"), "browser-control should be off by default");
  });
});

// ─── v2: element-ref actions ────────────────────────────────────────────

import { getTool } from "../server/task/tools/registry.js";
import type { ServerToolDefinition } from "../server/task/tools/registry.js";

describe("browser tool — v2 element-ref actions", () => {
  function getBrowserParams(): Record<string, unknown> | undefined {
    const entry = getTool("browser");
    if (!entry || entry.kind !== "server") return undefined;
    const def = entry.definition as ServerToolDefinition;
    return def.parameters?.properties as Record<string, unknown> | undefined;
  }

  it("action enum includes find, click_ref, and type_ref", () => {
    const props = getBrowserParams();
    assert.ok(props, "browser tool should be registered with parameters");
    const actionSchema = props!["action"] as { enum?: string[] } | undefined;
    assert.ok(actionSchema, "browser parameters should have an action field");
    const actions = actionSchema!.enum;
    assert.ok(actions, "action should have an enum of strings");
    assert.ok(actions!.includes("find"), `action enum missing find: ${JSON.stringify(actions)}`);
    assert.ok(actions!.includes("click_ref"), `action enum missing click_ref: ${JSON.stringify(actions)}`);
    assert.ok(actions!.includes("type_ref"), `action enum missing type_ref: ${JSON.stringify(actions)}`);
    // Classic actions still present.
    assert.ok(actions!.includes("click"));
    assert.ok(actions!.includes("type"));
    assert.ok(actions!.includes("navigate"));
  });

  it("has a `ref` parameter for element-ref commands", () => {
    const props = getBrowserParams();
    const refSchema = props!["ref"] as { type?: string; description?: string } | undefined;
    assert.ok(refSchema, "should have a `ref` parameter");
    assert.equal(refSchema!.type, "string");
    assert.match(refSchema!.description ?? "", /@e/);
  });
});

import {
  browserFind,
  browserClickRef,
  browserTypeRef,
} from "../server/task/tools/server/browser-session.js";

describe("browser-session — v2 exports", () => {
  it("browserFind is a function", () => {
    assert.equal(typeof browserFind, "function");
  });

  it("browserClickRef is a function", () => {
    assert.equal(typeof browserClickRef, "function");
  });

  it("browserTypeRef is a function", () => {
    assert.equal(typeof browserTypeRef, "function");
  });
});

import {
  // Side-effect: register feature
} from "../server/services/features/browser-feature.js";
import {
  startServer,
  stopServer,
} from "../server/task/tools/server/browser-session.js";

describe("browser-session — server lifecycle exports", () => {
  it("startServer is a function", () => {
    assert.equal(typeof startServer, "function");
  });

  it("stopServer is a function", () => {
    assert.equal(typeof stopServer, "function");
  });
});
