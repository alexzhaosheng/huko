/**
 * tests/debug-llm-log.test.ts
 *
 * Pure rendering tests for the debug llm-log HTML composer.
 *
 * No DB, no real session — we hand-build EntryRow + TaskRow fixtures
 * and assert the rendered HTML structure.
 *
 * Coverage:
 *   - Page header includes session id, task count, call count, total tokens
 *   - Each task gets its own <section class="task">
 *   - System prompt rendered in collapsible <details>
 *   - Each ai_message becomes one <article class="llm-call">
 *   - Inputs to call #1 include the user message; subsequent calls show only the delta
 *   - tool_result entries surface tool name + arguments
 *   - system_reminder entries get the reminder colour class
 *   - tool_calls metadata is rendered under the assistant response
 *   - Usage tokens render in the page header total + per-call detail
 *   - HTML is well-escaped (no raw <script>, no double-escaped &amp;amp;)
 *   - "After the last LLM response" trailing-entries section appears when needed
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { renderLlmLogHtml } from "../server/cli/commands/debug-llm-log.js";
import type { ChatSessionRow, EntryRow, TaskRow } from "../server/persistence/types.js";

// ─── Fixture builders ───────────────────────────────────────────────────────

function session(id = 1, title = "test session"): ChatSessionRow {
  return {
    id,
    title,
    createdAt: 0,
    updatedAt: 0,
  };
}

function task(id: number, status: TaskRow["status"] = "done", overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    chatSessionId: 1,
    agentSessionId: null,
    status,
    modelId: "claude-sonnet-4-6",
    toolCallMode: "native",
    thinkLevel: "off",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    toolCallCount: 2,
    iterationCount: 3,
    finalResult: "",
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let nextEntryId = 1;
function entry(taskId: number, partial: Partial<EntryRow>): EntryRow {
  return {
    id: nextEntryId++,
    taskId,
    sessionId: 1,
    sessionType: "chat",
    kind: "user_message",
    role: "user",
    content: "",
    toolCallId: null,
    thinking: null,
    metadata: null,
    createdAt: 0,
    ...partial,
  };
}

function aiMessage(
  taskId: number,
  content: string,
  meta: Record<string, unknown> = {},
): EntryRow {
  return entry(taskId, {
    kind: "ai_message",
    role: "assistant",
    content,
    metadata: {
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
      ...meta,
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("renderLlmLogHtml — page header", () => {
  it("includes session id, task count, call count, total tokens", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "hello" }),
      aiMessage(1, "hi"),
    ];
    const html = renderLlmLogHtml({
      session: session(7, "demo"),
      tasks: [task(1)],
      entries,
      generatedAt: new Date("2026-05-10T00:00:00Z"),
    });
    assert.match(html, /huko LLM log/);
    assert.match(html, /#7/);
    assert.match(html, /demo/);
    assert.match(html, /<dt>Tasks<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>LLM calls<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>Total tokens<\/dt><dd>100/);
    assert.match(html, /2026-05-10T00:00:00\.000Z/);
  });
});

describe("renderLlmLogHtml — task block", () => {
  it("renders one <section class=task> per task", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "first task" }),
      aiMessage(1, "ok"),
      entry(2, { kind: "user_message", role: "user", content: "second task" }),
      aiMessage(2, "ack"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1), task(2, "running")],
      entries,
      generatedAt: new Date(),
    });
    const matches = html.match(/<section class="task"/g) ?? [];
    assert.equal(matches.length, 2);
    assert.match(html, /Task #1/);
    assert.match(html, /Task #2/);
    assert.match(html, /badge status-done/);
    assert.match(html, /badge status-running/);
  });

  it("renders system_prompt in collapsible <details>", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, {
        kind: "system_prompt",
        role: "system",
        content: "You are a helper.",
      }),
      entry(1, { kind: "user_message", role: "user", content: "go" }),
      aiMessage(1, "done"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /<details class="system-prompt">/);
    assert.match(html, /You are a helper\./);
    // system_prompt should NOT also appear as a regular history entry.
    const sysHistMatches = html.match(/class="entry system"/g) ?? [];
    assert.equal(sysHistMatches.length, 0);
  });
});

describe("renderLlmLogHtml — LLM call panels", () => {
  it("emits one <article class=llm-call> per ai_message", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "hi" }),
      aiMessage(1, "first response"),
      entry(1, {
        kind: "tool_result",
        role: "tool",
        content: "tool out",
        metadata: { toolName: "read_file", arguments: { path: "/x" } },
      }),
      aiMessage(1, "second response"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    const matches = html.match(/<article class="llm-call"/g) ?? [];
    assert.equal(matches.length, 2);
    assert.match(html, /LLM call #1/);
    assert.match(html, /LLM call #2/);
  });

  it("call #1 inputs include the user message; call #2 inputs are the delta", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "USER_PROMPT" }),
      aiMessage(1, "FIRST_RESPONSE"),
      entry(1, {
        kind: "tool_result",
        role: "tool",
        content: "TOOL_OUTPUT",
        metadata: { toolName: "bash" },
      }),
      aiMessage(1, "SECOND_RESPONSE"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });

    // Slice each <article> block to test inputs in isolation.
    const articles = html.split('<article class="llm-call"').slice(1);
    assert.equal(articles.length, 2);

    const call1 = articles[0]!;
    assert.match(call1, /USER_PROMPT/);
    assert.doesNotMatch(call1, /TOOL_OUTPUT/);
    assert.match(call1, /Inputs<\/h4>/);

    const call2 = articles[1]!;
    // Delta only — user prompt should NOT reappear here.
    assert.doesNotMatch(call2, /USER_PROMPT/);
    assert.match(call2, /Inputs \(delta since previous call\)/);
    assert.match(call2, /TOOL_OUTPUT/);
    // The previous assistant turn is shown above as call #1's output, so
    // it should NOT be repeated as call #2's input either.
    assert.doesNotMatch(call2.split("Assistant response")[0]!, /FIRST_RESPONSE/);
  });

  it("renders 'no new entries since previous call' when delta is empty", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "hi" }),
      aiMessage(1, "a"),
      // No tool_result / reminder between the two ai_messages.
      aiMessage(1, "b"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /no new entries since previous call/);
  });
});

describe("renderLlmLogHtml — entry types", () => {
  it("tool_result shows tool name + arguments + content", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling tool"),
      entry(1, {
        kind: "tool_result",
        role: "tool",
        content: "RESULT_BODY",
        metadata: {
          toolName: "read_file",
          arguments: { path: "/a/b.txt" },
        },
      }),
      aiMessage(1, "done"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /class="tool-name">read_file<\/span>/);
    assert.match(html, /<details class="tool-args">/);
    assert.match(html, /\/a\/b\.txt/);
    assert.match(html, /RESULT_BODY/);
  });

  it("tool_result with error gets the error class", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling tool"),
      entry(1, {
        kind: "tool_result",
        role: "tool",
        content: "Error: nope",
        metadata: { toolName: "bash", error: "command failed" },
      }),
      aiMessage(1, "done"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /class="entry tool-result error"/);
  });

  it("system_reminder gets the reminder class", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "first"),
      entry(1, {
        kind: "system_reminder",
        role: "user",
        content: "<system_reminder reason=\"plan_update_followup\">If user changes scope...</system_reminder>",
        metadata: { reminderReason: "plan_update_followup" },
      }),
      aiMessage(1, "second"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /class="entry reminder"/);
    assert.match(html, /If user changes scope/);
  });

  it("ai_message with toolCalls metadata renders them in the output panel", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling things", {
        toolCalls: [
          { id: "c1", name: "read_file", arguments: { path: "/a" } },
          { id: "c2", name: "grep", arguments: { pattern: "foo" } },
        ],
      }),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /Tool calls \(2\)/);
    assert.match(html, /tool-call-block/);
    assert.match(html, /class="tool-name">read_file<\/span>/);
    assert.match(html, /class="tool-name">grep<\/span>/);
  });

  it("ai_message with thinking metadata renders it as collapsible", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "answer", { thinking: "long internal monologue" }),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /<details class="thinking">/);
    assert.match(html, /long internal monologue/);
  });
});

describe("renderLlmLogHtml — escaping", () => {
  it("escapes user-supplied HTML in content", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, {
        kind: "user_message",
        role: "user",
        content: '<script>alert("XSS")</script>',
      }),
      aiMessage(1, "& < > \" '"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /&amp; &lt; &gt; &quot; &#39;/);
  });
});

describe("renderLlmLogHtml — trailing entries", () => {
  it("renders entries after the last ai_message under a 'After the last LLM response' header", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling"),
      entry(1, {
        kind: "tool_result",
        role: "tool",
        content: "TRAILING",
        metadata: { toolName: "bash" },
      }),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /After the last LLM response/);
    assert.match(html, /TRAILING/);
  });
});
