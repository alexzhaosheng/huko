/**
 * tests/build-system-prompt.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Side-effect: register all built-in tools so getToolPromptHints() returns them.
import "../server/task/tools/index.js";
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../server/services/build-system-prompt.js";
import { getToolPromptHints } from "../server/task/tools/registry.js";
import type { LLMCallOptions, LLMMessage } from "../server/core/llm/types.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

async function buildWith(opts: {
  cwd?: string;
  workingLanguage?: string | null;
  currentDate?: Date;
  toolHints?: string[];
}): Promise<string> {
  const built: Parameters<typeof buildSystemPrompt>[0] = {
    cwd: opts.cwd ?? "/tmp",
    currentDate: opts.currentDate ?? new Date("2026-05-10T12:00:00Z"),
    toolHints: opts.toolHints ?? getToolPromptHints(),
  };
  if (opts.workingLanguage !== undefined) built.workingLanguage = opts.workingLanguage;
  return buildSystemPrompt(built);
}

// ─── Static structure ───────────────────────────────────────────────────────

describe("buildSystemPrompt — structural blocks", () => {
  it("includes all required XML-tagged sections", async () => {
    const prompt = await buildWith({});
    for (const tag of [
      "<scope>",
      "<principles>",
      "<language>",
      "<format>",
      "<agent_loop>",
      "<tool_use>",
      "<error_handling>",
      "<local>",
      "<safety>",
      "<disclosure_prohibition>",
    ]) {
      assert.ok(prompt.includes(tag), `missing ${tag} in prompt`);
    }
  });

  it("does NOT include a static <role> overlay (removed in 2026-05 redesign)", async () => {
    const prompt = await buildWith({});
    assert.doesNotMatch(prompt, /<role[\s>]/);
  });

  it("<scope> mentions the 4 expertise capabilities", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /<scope>/);
    for (const cap of ["coding", "writing", "research", "analysis"]) {
      assert.ok(prompt.includes(cap), `<scope> should mention "${cap}"`);
    }
  });

  it("identity is frontend-agnostic (no 'CLI-first')", async () => {
    const prompt = await buildWith({});
    assert.doesNotMatch(prompt, /CLI-first/);
    assert.match(prompt, /You are huko, an autonomous AI agent/);
  });

  it("contains the identity preamble", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /You are huko/);
  });

  it("includes one-tool-per-turn rule + plan rule + message rules", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /one tool call per response/i);
    assert.match(prompt, /plan\(action=update\)/);
    assert.match(prompt, /message\(type=ask\)/);
    assert.match(prompt, /message\(type=result\)/);
  });

  it("warns about system_reminder injections being platform guidance", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /system_reminder/);
    assert.match(prompt, /platform guidance/i);
  });

  it("tells the agent NOT to revisit older user requests after delivery (cross-task drift fix)", async () => {
    // Regression guard for the bug observed in huko's own session 2 task 6:
    // agent finished `git push` then auto-resumed an older stopped task's
    // goal ("write command.md"). The principle below should keep it from
    // scanning the conversation backwards for "leftover" requests.
    const prompt = await buildWith({});
    assert.match(prompt, /scan the conversation for older user requests/i);
    // The three explanations of why an earlier user_message might be there:
    // completed / stopped / superseded.
    assert.match(prompt, /completed.*stopped.*superseded/i);
  });
});

// ─── Cache boundary ─────────────────────────────────────────────────────────

describe("buildSystemPrompt — cache boundary", () => {
  it("places the marker exactly once", async () => {
    const prompt = await buildWith({});
    const idx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(idx > 0, "boundary marker should be present");
    const idx2 = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY, idx + 1);
    assert.equal(idx2, -1, "boundary marker should appear at most once");
  });

  it("places the marker BEFORE the current-date line", async () => {
    const prompt = await buildWith({
      currentDate: new Date("2026-05-10T12:00:00Z"),
    });
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const idxDate = prompt.indexOf("The current date is");
    assert.ok(idxBoundary > 0);
    assert.ok(idxDate > idxBoundary, "date should appear after boundary");
  });

  it("places everything stable BEFORE the boundary", async () => {
    const prompt = await buildWith({});
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const idxScope = prompt.indexOf("<scope>");
    const idxLanguage = prompt.indexOf("<language>");
    assert.ok(idxLanguage > 0 && idxLanguage < idxBoundary);
    assert.ok(idxScope > 0 && idxScope < idxBoundary);
  });
});

// ─── Language block ─────────────────────────────────────────────────────────

describe("buildSystemPrompt — <language> block", () => {
  it("locks onto the supplied workingLanguage", async () => {
    const prompt = await buildWith({ workingLanguage: "中文" });
    assert.match(prompt, /working language is \*\*中文\*\*/);
  });

  it("falls back when workingLanguage is null", async () => {
    const prompt = await buildWith({ workingLanguage: null });
    assert.match(prompt, /first message as the working language/i);
  });

  it("falls back when workingLanguage is omitted", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /first message as the working language/i);
  });
});

// ─── Local block ────────────────────────────────────────────────────────────

describe("buildSystemPrompt — <local> block", () => {
  it("renders cwd and platform", async () => {
    const prompt = await buildWith({ cwd: "/some/project/path" });
    assert.match(prompt, /Working directory: \/some\/project\/path/);
    assert.match(prompt, new RegExp(`Platform: ${process.platform}`));
  });

  it("includes workspace_policy and local_safety sub-blocks", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /<workspace_policy>/);
    assert.match(prompt, /<local_safety>/);
  });
});

// ─── project_context multi-file ─────────────────────────────────────────────

describe("buildSystemPrompt — project context (AGENTS.md / CLAUDE.md / HUKO.md)", () => {
  it("inserts <project_context> when CLAUDE.md exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-claude-"));
    try {
      writeFileSync(join(tmp, "CLAUDE.md"), "# Project rules\n\n- always wear seatbelts\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      assert.match(prompt, /<project_context>/);
      assert.match(prompt, /# From CLAUDE\.md/);
      assert.match(prompt, /always wear seatbelts/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts <project_context> when AGENTS.md exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-agents-"));
    try {
      writeFileSync(join(tmp, "AGENTS.md"), "- agents-only rule\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      assert.match(prompt, /# From AGENTS\.md/);
      assert.match(prompt, /agents-only rule/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts <project_context> when HUKO.md exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-huko-"));
    try {
      writeFileSync(join(tmp, "HUKO.md"), "- huko-specific override\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      assert.match(prompt, /# From HUKO\.md/);
      assert.match(prompt, /huko-specific override/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("concats all three files in order AGENTS, CLAUDE, HUKO", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-trio-"));
    try {
      writeFileSync(join(tmp, "AGENTS.md"), "rule-A\n", "utf8");
      writeFileSync(join(tmp, "CLAUDE.md"), "rule-C\n", "utf8");
      writeFileSync(join(tmp, "HUKO.md"), "rule-H\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      const idxA = prompt.indexOf("# From AGENTS.md");
      const idxC = prompt.indexOf("# From CLAUDE.md");
      const idxH = prompt.indexOf("# From HUKO.md");
      assert.ok(idxA > 0 && idxC > idxA && idxH > idxC,
        `expected order AGENTS < CLAUDE < HUKO, got ${idxA}/${idxC}/${idxH}`);
      assert.match(prompt, /rule-A/);
      assert.match(prompt, /rule-C/);
      assert.match(prompt, /rule-H/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores empty / whitespace-only files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-empty-"));
    try {
      writeFileSync(join(tmp, "AGENTS.md"), "  \n\n\n", "utf8");
      writeFileSync(join(tmp, "CLAUDE.md"), "real rule\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      assert.doesNotMatch(prompt, /# From AGENTS\.md/);
      assert.match(prompt, /# From CLAUDE\.md/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits <project_context> when none of the three files exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-noclaude-"));
    try {
      const prompt = await buildWith({ cwd: tmp });
      assert.doesNotMatch(prompt, /<project_context>/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("places <project_context> as the LAST block before the cache boundary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-projectlast-"));
    try {
      writeFileSync(join(tmp, "CLAUDE.md"), "# Project\n", "utf8");
      const prompt = await buildWith({ cwd: tmp });
      const idxProj = prompt.indexOf("<project_context>");
      const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      assert.ok(idxProj > 0);
      assert.ok(idxBoundary > idxProj);
      const between = prompt.slice(
        prompt.indexOf("</project_context>") + "</project_context>".length,
        idxBoundary,
      );
      assert.equal(
        between.trim(),
        "",
        `unexpected content between </project_context> and boundary: ${JSON.stringify(between)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Skills block ───────────────────────────────────────────────────────────

describe("buildSystemPrompt — <skills> block", () => {
  it("omits the <skills> block entirely when no skill is active", async () => {
    const { resetConfigForTests } = await import("../server/config/loader.js");
    resetConfigForTests();
    try {
      const prompt = await buildWith({});
      assert.doesNotMatch(prompt, /<skills>/);
    } finally {
      resetConfigForTests();
    }
  });

  it("injects a <skill> entry with description + body when one is enabled", async () => {
    const { mkdirSync } = await import("node:fs");
    const { resetConfigForTests, setConfigForTests } = await import(
      "../server/config/loader.js"
    );
    const { DEFAULT_CONFIG } = await import("../server/config/types.js");

    const tmp = mkdtempSync(join(tmpdir(), "huko-skills-prompt-"));
    const savedHome = process.env["HOME"];
    const altHome = mkdtempSync(join(tmpdir(), "huko-skills-prompt-home-"));
    process.env["HOME"] = altHome;
    process.env["USERPROFILE"] = altHome;
    try {
      const dir = join(tmp, ".huko", "skills");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "deploy.md"),
        `---
description: pre-deploy checklist
---

Run tests before shipping.`,
        "utf8",
      );

      setConfigForTests({
        ...DEFAULT_CONFIG,
        skills: { deploy: { enabled: true } },
      });

      const prompt = await buildWith({ cwd: tmp });
      assert.match(prompt, /<skills>/);
      assert.match(prompt, /<skill name="deploy">/);
      assert.match(prompt, /pre-deploy checklist/);
      assert.match(prompt, /Run tests before shipping\./);

      // Slot order: <skills> sits before <project_context> (which may be
      // absent here) AND before the cache boundary.
      const skillsIdx = prompt.indexOf("<skills>");
      const boundaryIdx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      assert.ok(skillsIdx > 0 && skillsIdx < boundaryIdx);
    } finally {
      resetConfigForTests();
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(altHome, { recursive: true, force: true });
    }
  });
});

// ─── OpenAI adapter strip ───────────────────────────────────────────────────

describe("openai adapter strips cache boundary marker", () => {
  it("removes the marker from system messages before send", async () => {
    const { openaiAdapter } = await import("../server/core/llm/adapters/openai.js");

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `BEFORE${SYSTEM_PROMPT_CACHE_BOUNDARY}AFTER`,
      },
      { role: "user", content: "hi" },
    ];

    let captured: { messages: Array<{ role: string; content: unknown }> } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? "{}");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: [] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const opts: LLMCallOptions = {
        protocol: "openai",
        baseUrl: "https://example.invalid",
        apiKey: "k",
        model: "gpt-test",
        messages,
        tools: [],
        toolCallMode: "native",
        thinkLevel: "off",
      };
      await openaiAdapter.call(opts);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(captured, "fetch was not invoked");
    const sysMsg = captured!.messages.find((m) => m.role === "system");
    assert.ok(sysMsg, "system message missing in payload");
    const content = String(sysMsg!.content);
    assert.equal(content, "BEFOREAFTER");
    assert.doesNotMatch(content, /CACHE_BOUNDARY/);
  });
});
