/**
 * tests/safety-disabled-filter.test.ts
 *
 * Pins `getToolsForLLM`'s new behavior: tools with merged
 * `safety.toolRules.<name>.disabled === true` are filtered out of the
 * surface entirely — both full and lean modes, both server and
 * workstation tools. Stronger than `deny` patterns (which keep the
 * tool visible to the LLM).
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: registers every built-in tool.
import "../server/task/tools/index.js";
import { getToolsForLLM } from "../server/task/tools/registry.js";
import { resetConfigForTests, setConfigForTests } from "../server/config/loader.js";
import { DEFAULT_CONFIG } from "../server/config/types.js";

beforeEach(() => {
  resetConfigForTests();
});
afterEach(() => {
  resetConfigForTests();
});

function configWithDisabled(...names: string[]) {
  const toolRules: Record<string, { disabled: true }> = {};
  for (const n of names) toolRules[n] = { disabled: true };
  return {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      toolRules,
    },
  };
}

describe("getToolsForLLM — safety.toolRules.<tool>.disabled filter", () => {
  it("removes a single disabled tool from the surface", () => {
    setConfigForTests(configWithDisabled("bash"));
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("bash"), `bash should be filtered out, got: ${names.join(", ")}`);
    // Other tools are still there.
    assert.ok(names.includes("read_file"));
  });

  it("filters in lean mode too (not just full)", () => {
    setConfigWithBashDisabled();
    const lean = getToolsForLLM({ lean: true });
    assert.ok(!lean.some((t) => t.name === "bash"));
  });

  it("disabled tool stays gone even when explicitly allowedTools-listed", () => {
    // Operator-level disable beats caller's allowlist — the safety
    // policy is the trump card; if the user has banned a tool, no
    // call site should be able to opt back in.
    setConfigWithBashDisabled();
    const tools = getToolsForLLM({ allowedTools: ["bash", "read_file"] });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("bash"));
    assert.ok(names.includes("read_file"));
  });

  it("multiple disabled tools all get filtered", () => {
    setConfigForTests(configWithDisabled("bash", "write_file"));
    const tools = getToolsForLLM();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("bash"));
    assert.ok(!names.includes("write_file"));
  });

  it("unspecified disabled (config not loaded) doesn't filter anything", () => {
    // Don't set config — the helper should just no-op.
    resetConfigForTests();
    const tools = getToolsForLLM();
    // bash + at least a few others should be present.
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("bash"));
    assert.ok(names.length > 5);
  });
});

// Helper re-used a few times.
function setConfigWithBashDisabled(): void {
  setConfigForTests(configWithDisabled("bash"));
}
