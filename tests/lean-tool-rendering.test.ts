/**
 * tests/lean-tool-rendering.test.ts
 *
 * Verifies the lean / default split inside `materialise()` in the tool
 * registry. Two requirements:
 *
 *   1. Lean mode picks `leanDescription` (falling back to `description`
 *      when unset) and ignores `platformNotes` / `descriptionFor` /
 *      `parametersFor` — those are default-mode rendering hooks.
 *
 *   2. Default mode is unchanged by the addition of `leanDescription`
 *      (no leakage in the reverse direction).
 *
 * The two paths must remain structurally isolated so a change to one
 * description can't bleed into the other.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: registers every built-in tool, including bash with its
// real `description` + `leanDescription` pair.
import "../server/task/tools/index.js";
import { getToolsForLLM } from "../server/task/tools/registry.js";

describe("getToolsForLLM — lean rendering", () => {
  it("renders bash with its leanDescription when lean=true", () => {
    const tools = getToolsForLLM({ allowedTools: ["bash"], lean: true });
    assert.equal(tools.length, 1);
    const bash = tools[0]!;
    assert.equal(bash.name, "bash");

    // Lean variant traits.
    assert.match(bash.description, /persistent|preserves|cd foo/i);
    assert.match(bash.description, /timeout/i);
    assert.match(bash.description, /Windows|cmd\.exe/);

    // Default-mode content must NOT appear in the lean rendering.
    assert.doesNotMatch(bash.description, /<actions>/);
    assert.doesNotMatch(bash.description, /<sessions>/);
    assert.doesNotMatch(bash.description, /<limits>/);
    assert.doesNotMatch(bash.description, /<instructions>/);
    assert.doesNotMatch(bash.description, /send.*write raw/i);
    assert.doesNotMatch(bash.description, /SIGTERM/);
  });

  it("renders bash with the full description when lean=false (or omitted)", () => {
    const tools = getToolsForLLM({ allowedTools: ["bash"] });
    assert.equal(tools.length, 1);
    const bash = tools[0]!;

    // Default content blocks must appear.
    assert.match(bash.description, /<actions>/);
    assert.match(bash.description, /<sessions>/);
    assert.match(bash.description, /<limits>/);
    assert.match(bash.description, /<instructions>/);
  });

  it("lean description is materially smaller than default", () => {
    const leanTools = getToolsForLLM({ allowedTools: ["bash"], lean: true });
    const fullTools = getToolsForLLM({ allowedTools: ["bash"] });
    const leanLen = leanTools[0]!.description.length;
    const fullLen = fullTools[0]!.description.length;
    // Expect at least a 3x reduction. Real numbers (May 2026): full ≈ 1600,
    // lean ≈ 500 → ratio ≈ 3.2x. This assertion locks the design intent
    // without being brittle to small wording tweaks on either side.
    assert.ok(
      leanLen * 3 < fullLen,
      `lean=${leanLen} chars, full=${fullLen} chars — lean should be <1/3 of full`,
    );
  });

  it("tools without leanDescription fall back to description in lean mode", () => {
    // `message` has no leanDescription set. (It's not in lean's allowedTools
    // by default, but the renderer must still behave when included.)
    const tools = getToolsForLLM({ allowedTools: ["message"], lean: true });
    assert.equal(tools.length, 1);
    const msg = tools[0]!;
    // Falls back to the full description — non-empty and recognisable.
    assert.ok(msg.description.length > 100);
  });
});

// ─── platformNotes (Windows-only addendum) ───────────────────────────────────

describe("getToolsForLLM — platformNotes", () => {
  // ToolFilterContext doesn't expose a platform override, so the only
  // way to exercise the Windows path is by temporarily overriding
  // `process.platform`. It's a primitive property but `Object.defineProperty`
  // lets us swap it for the duration of the test.
  function withPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: p, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  }

  it("appends the win32 note ONLY on Windows", () => {
    const winBash = withPlatform("win32", () =>
      getToolsForLLM({ allowedTools: ["bash"] })[0]!,
    );
    const linuxBash = withPlatform("linux", () =>
      getToolsForLLM({ allowedTools: ["bash"] })[0]!,
    );
    const darwinBash = withPlatform("darwin", () =>
      getToolsForLLM({ allowedTools: ["bash"] })[0]!,
    );

    assert.match(winBash.description, /<platform>/);
    assert.match(winBash.description, /cmd\.exe/);
    assert.match(winBash.description, /dir.*not.*ls/);

    assert.doesNotMatch(linuxBash.description, /<platform>/);
    assert.doesNotMatch(linuxBash.description, /cmd\.exe/);
    assert.doesNotMatch(darwinBash.description, /<platform>/);
    assert.doesNotMatch(darwinBash.description, /cmd\.exe/);
  });

  it("Linux description is shorter than Windows description", () => {
    const winLen = withPlatform("win32", () =>
      getToolsForLLM({ allowedTools: ["bash"] })[0]!.description.length,
    );
    const linuxLen = withPlatform("linux", () =>
      getToolsForLLM({ allowedTools: ["bash"] })[0]!.description.length,
    );
    assert.ok(
      linuxLen < winLen,
      `linux=${linuxLen}, win=${winLen} — linux must save the platformNote chars`,
    );
  });

  it("lean mode ignores platformNotes regardless of platform", () => {
    // Lean's slim description carries its own one-liner Windows hint;
    // the registry's platformNotes hook is a default-mode-only feature.
    const winLean = withPlatform("win32", () =>
      getToolsForLLM({ allowedTools: ["bash"], lean: true })[0]!,
    );
    const linuxLean = withPlatform("linux", () =>
      getToolsForLLM({ allowedTools: ["bash"], lean: true })[0]!,
    );
    assert.equal(
      winLean.description,
      linuxLean.description,
      "lean rendering must be platform-agnostic",
    );
  });
});
