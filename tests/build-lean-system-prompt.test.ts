/**
 * tests/build-lean-system-prompt.test.ts
 *
 * Verifies that the lean composer is structurally isolated from the
 * default composer — it must NOT contain any of the default's content
 * blocks (agent_loop, tool_use rules, project_context, role, etc.).
 * Adding content to either composer must not leak into the other.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildLeanSystemPrompt,
} from "../server/services/build-lean-system-prompt.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../server/services/build-system-prompt.js";

describe("buildLeanSystemPrompt", () => {
  it("produces a compact prompt (target ~300-500 tokens, <1500 chars)", () => {
    const out = buildLeanSystemPrompt({ workingLanguage: "English" });
    assert.ok(out.length < 1500, `lean prompt should be small, got ${out.length} chars`);
    assert.ok(out.length > 100, "lean prompt should not be empty");
  });

  it("mentions bash as the one available tool", () => {
    const out = buildLeanSystemPrompt({});
    assert.match(out, /\bbash\b/);
  });

  it("does NOT include default-composer content blocks", () => {
    const out = buildLeanSystemPrompt({});
    // Sections owned by the default composer must never appear here.
    assert.doesNotMatch(out, /<agent_loop>/);
    assert.doesNotMatch(out, /<tool_use>/);
    assert.doesNotMatch(out, /<error_handling>/);
    assert.doesNotMatch(out, /<local>/);
    assert.doesNotMatch(out, /<safety>/);
    assert.doesNotMatch(out, /<disclosure_prohibition>/);
    assert.doesNotMatch(out, /<role/);
    assert.doesNotMatch(out, /<project_context>/);
    assert.doesNotMatch(out, /<format>/);
  });

  it("retains the cache boundary sentinel and date line at the tail", () => {
    const out = buildLeanSystemPrompt({});
    assert.ok(out.includes(SYSTEM_PROMPT_CACHE_BOUNDARY), "must keep cache boundary");
    assert.match(out, /The current date is /);
    // The volatile date line must live AFTER the boundary so the cache
    // prefix stays stable across calls.
    const boundaryIdx = out.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const dateIdx = out.indexOf("The current date is ");
    assert.ok(dateIdx > boundaryIdx, "date must appear after boundary");
  });

  it("includes the working-language block with the supplied language", () => {
    const out = buildLeanSystemPrompt({ workingLanguage: "中文" });
    assert.match(out, /<language>/);
    assert.match(out, /\*\*中文\*\*/);
  });

  it("falls back to first-message-language directive when language is null", () => {
    const out = buildLeanSystemPrompt({});
    assert.match(out, /first message/);
  });

  it("identity line marks the mode explicitly", () => {
    const out = buildLeanSystemPrompt({});
    assert.match(out, /lean mode/);
  });
});
