/**
 * tests/build-system-prompt.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../server/services/build-system-prompt.js";
import { loadRole } from "../server/roles/index.js";
import type { LLMCallOptions, LLMMessage } from "../server/core/llm/types.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

async function buildWith(opts: {
  roleName?: string;
  cwd?: string;
  workingLanguage?: string | null;
  currentDate?: Date;
}): Promise<string> {
  const role = await loadRole(opts.roleName ?? "general", opts.cwd ?? "/tmp");
  const built: Parameters<typeof buildSystemPrompt>[0] = {
    role,
    cwd: opts.cwd ?? "/tmp",
    currentDate: opts.currentDate ?? new Date("2026-05-10T12:00:00Z"),
  };
  if (opts.workingLanguage !== undefined) built.workingLanguage = opts.workingLanguage;
  return buildSystemPrompt(built);
}

// ─── Static structure ───────────────────────────────────────────────────────

describe("buildSystemPrompt — structural blocks", () => {
  it("includes all required XML-tagged sections", async () => {
    const prompt = await buildWith({});
    for (const tag of [
      "<language>",
      "<format>",
      "<agent_loop>",
      "<tool_use>",
      "<error_handling>",
      "<local>",
      "<safety>",
      "<disclosure_prohibition>",
      "<role name=",
    ]) {
      assert.ok(prompt.includes(tag), `missing ${tag} in prompt`);
    }
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
    const idxRole = prompt.indexOf("<role name=");
    const idxLanguage = prompt.indexOf("<language>");
    assert.ok(idxLanguage > 0 && idxLanguage < idxBoundary);
    assert.ok(idxRole > 0 && idxRole < idxBoundary);
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

// ─── Role block ─────────────────────────────────────────────────────────────

describe("buildSystemPrompt — role overlay", () => {
  it("wraps role.body in <role name=...>", async () => {
    const prompt = await buildWith({ roleName: "writing" });
    assert.match(prompt, /<role name="writing">/);
    assert.match(prompt, /<\/role>/);
  });

  it("includes the role's persona text", async () => {
    const prompt = await buildWith({ roleName: "writing" });
    assert.match(prompt, /writing mode/i);
  });

  it("default role is general", async () => {
    const prompt = await buildWith({});
    assert.match(prompt, /<role name="general">/);
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

  it("places <project_context> BEFORE <role> when both exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-order-"));
    try {
      writeFileSync(join(tmp, "CLAUDE.md"), "# Project rules\n", "utf8");
      const prompt = await buildWith({ cwd: tmp, roleName: "general" });
      const idxProj = prompt.indexOf("<project_context>");
      const idxRole = prompt.indexOf("<role name=");
      assert.ok(idxProj > 0);
      assert.ok(idxRole > idxProj, "role should come AFTER project_context");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("places <role> as the LAST block before the cache boundary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "huko-prompt-rolelast-"));
    try {
      writeFileSync(join(tmp, "CLAUDE.md"), "# Project\n", "utf8");
      const prompt = await buildWith({ cwd: tmp, roleName: "general" });
      const idxRole = prompt.indexOf("<role name=");
      const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      assert.ok(idxRole > 0);
      assert.ok(idxBoundary > idxRole);
      const between = prompt.slice(prompt.indexOf("</role>") + "</role>".length, idxBoundary);
      assert.equal(between.trim(), "", `unexpected content between </role> and boundary: ${JSON.stringify(between)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
