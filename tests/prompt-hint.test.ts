/**
 * tests/prompt-hint.test.ts
 *
 * Coverage:
 *   - getToolPromptHints returns hints from registered tools
 *   - hints filtered out when allowedTools restricts visibility
 *   - hints filtered out when deniedTools blocks the tool
 *   - hints empty for tools without promptHint
 *   - buildSystemPrompt splices toolHints into <tool_use>
 *   - buildSystemPrompt's <tool_use> still has baseline rules + system_reminder line
 *   - When toolHints is empty, <tool_use> contains only baseline + system_reminder
 *   - Built-in message + plan + web_search + delete_file all contribute hints
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: register tools.
import "../server/task/tools/index.js";
import { getToolPromptHints } from "../server/task/tools/registry.js";
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../server/services/build-system-prompt.js";

// ─── getToolPromptHints ────────────────────────────────────────────────────

describe("getToolPromptHints", () => {
  it("returns hints from all registered tools by default", () => {
    const hints = getToolPromptHints();
    assert.ok(hints.length >= 4, `expected >= 4 hints, got ${hints.length}`);
    // Spot-check that the 4 hint-bearing tools all show up.
    const blob = hints.join("\n\n");
    assert.match(blob, /Talking to the user/);
    assert.match(blob, /Planning \(`plan`/);
    assert.match(blob, /Web research/);
    assert.match(blob, /File deletion/);
  });

  it("respects allowedTools filter", () => {
    const hints = getToolPromptHints({ allowedTools: ["message"] });
    assert.equal(hints.length, 1);
    assert.match(hints[0]!, /Talking to the user/);
  });

  it("respects deniedTools filter", () => {
    const hints = getToolPromptHints({ deniedTools: ["plan", "delete_file", "web_search"] });
    const blob = hints.join("\n\n");
    assert.match(blob, /Talking to the user/);
    assert.doesNotMatch(blob, /Planning \(`plan`/);
    assert.doesNotMatch(blob, /Web research/);
    assert.doesNotMatch(blob, /File deletion/);
  });

  it("returns empty when allowedTools is empty (no tools visible)", () => {
    const hints = getToolPromptHints({ allowedTools: [] });
    assert.deepEqual(hints, []);
  });

  it("preserves registration order", () => {
    const hints = getToolPromptHints();
    const idxMessage = hints.findIndex((h) => h.includes("Talking to the user"));
    const idxPlan = hints.findIndex((h) => h.includes("Planning (`plan`"));
    const idxSearch = hints.findIndex((h) => h.includes("Web research"));
    const idxDelete = hints.findIndex((h) => h.includes("File deletion"));
    // tools/index.ts imports message → plan → web-fetch → web-search → ...
    // → write-file → edit-file → delete-file → ...
    assert.ok(idxMessage >= 0 && idxPlan >= 0 && idxSearch >= 0 && idxDelete >= 0);
    assert.ok(idxMessage < idxPlan, "message should precede plan");
    assert.ok(idxPlan < idxSearch, "plan should precede web_search");
    assert.ok(idxSearch < idxDelete, "web_search should precede delete_file");
  });
});

// ─── buildSystemPrompt splices hints ───────────────────────────────────────

describe("buildSystemPrompt — toolHints integration", () => {
  it("splices the supplied hints into <tool_use>", async () => {
    const prompt = await buildSystemPrompt({
      cwd: "/tmp",
      toolHints: [
        "Custom hint A:\n- alpha rule",
        "Custom hint B:\n- bravo rule",
      ],
      currentDate: new Date("2026-05-10T12:00:00Z"),
    });
    // Hints land inside <tool_use> ... </tool_use>
    const m = /<tool_use>([\s\S]*?)<\/tool_use>/.exec(prompt);
    assert.ok(m, "no <tool_use> block found");
    const block = m![1]!;
    assert.match(block, /alpha rule/);
    assert.match(block, /bravo rule/);
    // Baseline rules still present
    assert.match(block, /one tool call per response/i);
    // System reminder line still present
    assert.match(block, /system_reminder/);
  });

  it("keeps <tool_use> minimal when no hints supplied", async () => {
    const prompt = await buildSystemPrompt({
      cwd: "/tmp",
      toolHints: [],
      currentDate: new Date("2026-05-10T12:00:00Z"),
    });
    const m = /<tool_use>([\s\S]*?)<\/tool_use>/.exec(prompt);
    assert.ok(m);
    const block = m![1]!;
    assert.match(block, /one tool call per response/i);
    assert.match(block, /system_reminder/);
    // No tool-specific subsections leaked from build-system-prompt anymore.
    assert.doesNotMatch(block, /Talking to the user/);
    assert.doesNotMatch(block, /Planning \(`plan`/);
  });

  it("real registered hints surface when getToolPromptHints is passed", async () => {
    const hints = getToolPromptHints();
    const prompt = await buildSystemPrompt({
      cwd: "/tmp",
      toolHints: hints,
      currentDate: new Date("2026-05-10T12:00:00Z"),
    });
    assert.match(prompt, /Talking to the user/);
    assert.match(prompt, /Planning \(`plan`/);
    assert.match(prompt, /Web research/);
    assert.match(prompt, /File deletion/);
    // All hints must be inside <tool_use>, not after it.
    const idxToolUseClose = prompt.indexOf("</tool_use>");
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const idxFileDeletion = prompt.indexOf("File deletion");
    assert.ok(idxFileDeletion < idxToolUseClose, "hint should be inside <tool_use>");
    assert.ok(idxToolUseClose < idxBoundary);
  });
});
