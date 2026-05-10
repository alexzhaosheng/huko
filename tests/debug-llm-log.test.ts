/**
 * tests/debug-llm-log.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildRawPayload,
  renderLlmLogHtml,
} from "../server/cli/commands/debug-llm-log.js";
import type { ChatSessionRow, EntryRow, TaskRow } from "../server/persistence/types.js";

// ─── Fixture builders ───────────────────────────────────────────────────────

function session(id = 1, title = "test session"): ChatSessionRow {
  return { id, title, createdAt: 0, updatedAt: 0 };
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

function aiMessage(taskId: number, content: string, meta: Record<string, unknown> = {}): EntryRow {
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

// ─── page header ────────────────────────────────────────────────────────────

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

// ─── task block ─────────────────────────────────────────────────────────────

describe("renderLlmLogHtml — task block", () => {
  it("renders one section per task", () => {
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

  it("renders system_prompt in collapsible details", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "system_prompt", role: "system", content: "You are a helper." }),
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
    const sysHistMatches = html.match(/class="entry system"/g) ?? [];
    assert.equal(sysHistMatches.length, 0);
  });
});

// ─── LLM call panels ────────────────────────────────────────────────────────

describe("renderLlmLogHtml — LLM call panels", () => {
  it("emits one article per ai_message", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "hi" }),
      aiMessage(1, "first response"),
      entry(1, { kind: "tool_result", role: "tool", content: "tool out", metadata: { toolName: "read_file", arguments: { path: "/x" } } }),
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

  it("call #1 inputs include user message; call #2 inputs are delta only", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "USER_PROMPT" }),
      aiMessage(1, "FIRST_RESPONSE"),
      entry(1, { kind: "tool_result", role: "tool", content: "TOOL_OUTPUT", metadata: { toolName: "bash" } }),
      aiMessage(1, "SECOND_RESPONSE"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    // Each article ends with a <dialog> reconstructing the full payload
    // (system + all earlier inputs), so we narrow the assertions to the
    // inputs section only — the part the reader sees first.
    const articles = html.split('<article class="llm-call"').slice(1);
    assert.equal(articles.length, 2);
    const inputs1 = articles[0]!.split('<div class="call-output">')[0]!;
    const inputs2 = articles[1]!.split('<div class="call-output">')[0]!;

    assert.match(inputs1, /USER_PROMPT/);
    assert.doesNotMatch(inputs1, /TOOL_OUTPUT/);
    assert.match(inputs1, /Inputs<\/h4>/);

    assert.doesNotMatch(inputs2, /USER_PROMPT/);
    assert.match(inputs2, /Inputs \(delta since previous call\)/);
    assert.match(inputs2, /TOOL_OUTPUT/);
    assert.doesNotMatch(inputs2, /FIRST_RESPONSE/);
  });

  it("renders 'no new entries since previous call' when delta is empty", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "hi" }),
      aiMessage(1, "a"),
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

// ─── entry types ────────────────────────────────────────────────────────────

describe("renderLlmLogHtml — entry types", () => {
  it("tool_result shows tool name + arguments + content", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling tool"),
      entry(1, { kind: "tool_result", role: "tool", content: "RESULT_BODY", metadata: { toolName: "read_file", arguments: { path: "/a/b.txt" } } }),
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
      entry(1, { kind: "tool_result", role: "tool", content: "Error: nope", metadata: { toolName: "bash", error: "command failed" } }),
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
      entry(1, { kind: "system_reminder", role: "user", content: "<system_reminder reason=\"plan_update_followup\">If user changes scope...</system_reminder>", metadata: { reminderReason: "plan_update_followup" } }),
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

// ─── escaping ───────────────────────────────────────────────────────────────

describe("renderLlmLogHtml — escaping", () => {
  it("escapes user-supplied HTML in content", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: '<script>alert("XSS")</script>' }),
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

// ─── trailing entries ───────────────────────────────────────────────────────

describe("renderLlmLogHtml — trailing entries", () => {
  it("renders entries after the last ai_message", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "calling"),
      entry(1, { kind: "tool_result", role: "tool", content: "TRAILING", metadata: { toolName: "bash" } }),
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

// ─── buildRawPayload ───────────────────────────────────────────────────────

describe("buildRawPayload", () => {
  it("includes the system prompt as the first message", () => {
    nextEntryId = 1;
    const sys = entry(1, { kind: "system_prompt", role: "system", content: "SYSPROMPT" });
    const u = entry(1, { kind: "user_message", role: "user", content: "hi" });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: sys,
      historyEntries: [sys, u],
    });
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0]!.role, "system");
    assert.equal(payload.messages[0]!.content, "SYSPROMPT");
    assert.equal(payload.messages[1]!.role, "user");
    assert.equal(payload.messages[1]!.content, "hi");
    assert.equal(payload.model, "claude-sonnet-4-6");
  });

  it("flags missing system prompt in notes", () => {
    nextEntryId = 1;
    const u = entry(1, { kind: "user_message", role: "user", content: "hi" });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: null,
      historyEntries: [u],
    });
    assert.equal(payload.messages[0]!.role, "user");
    assert.ok(payload.notes.some((n) => /system_prompt not persisted/i.test(n)));
  });

  it("folds toolCalls metadata into the assistant message's tool_calls", () => {
    nextEntryId = 1;
    const u = entry(1, { kind: "user_message", role: "user", content: "x" });
    const a = aiMessage(1, "calling", {
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/a" } }],
    });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: null,
      historyEntries: [u, a],
    });
    const assistant = payload.messages[1]! as Record<string, unknown>;
    assert.equal(assistant["role"], "assistant");
    const tc = assistant["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(tc.length, 1);
    assert.equal(tc[0]!["id"], "c1");
    assert.equal((tc[0]!["function"] as Record<string, unknown>)["name"], "read_file");
    const argsStr = (tc[0]!["function"] as Record<string, unknown>)["arguments"];
    assert.equal(typeof argsStr, "string");
    assert.deepEqual(JSON.parse(argsStr as string), { path: "/a" });
  });

  it("renders tool_result rows as {role: tool, tool_call_id, content}", () => {
    nextEntryId = 1;
    const u = entry(1, { kind: "user_message", role: "user", content: "x" });
    const a = aiMessage(1, "calling", {
      toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }],
    });
    const tr = entry(1, {
      kind: "tool_result",
      role: "tool",
      content: "RESULT",
      toolCallId: "c1",
      metadata: { toolName: "bash" },
    });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: null,
      historyEntries: [u, a, tr],
    });
    const last = payload.messages[2]!;
    assert.equal(last.role, "tool");
    assert.equal(last["tool_call_id"], "c1");
    assert.equal(last.content, "RESULT");
  });

  it("renders system_reminder as a user message", () => {
    nextEntryId = 1;
    const u = entry(1, { kind: "user_message", role: "user", content: "x" });
    const a = aiMessage(1, "first");
    const rem = entry(1, {
      kind: "system_reminder",
      role: "user",
      content: "<system_reminder reason=\"x\">be careful</system_reminder>",
    });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: null,
      historyEntries: [u, a, rem],
    });
    const reminder = payload.messages[2]!;
    assert.equal(reminder.role, "user");
    assert.match(String(reminder.content), /be careful/);
  });

  it("skips status_notice and tool_call entries", () => {
    nextEntryId = 1;
    const u = entry(1, { kind: "user_message", role: "user", content: "x" });
    const status = entry(1, { kind: "status_notice", role: "system", content: "noise" });
    const tc = entry(1, { kind: "tool_call", role: "assistant", content: "old" });
    const payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: null,
      historyEntries: [u, status, tc],
    });
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0]!.role, "user");
  });

  it("each call's payload grows with new entries since the previous call", () => {
    nextEntryId = 1;
    const sys = entry(1, { kind: "system_prompt", role: "system", content: "SYS" });
    const u = entry(1, { kind: "user_message", role: "user", content: "hi" });
    const a1 = aiMessage(1, "first");
    const tr = entry(1, {
      kind: "tool_result",
      role: "tool",
      content: "TR",
      toolCallId: "c1",
      metadata: { toolName: "bash" },
    });
    const _a2 = aiMessage(1, "second");
    void _a2;

    const call1Payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: sys,
      historyEntries: [sys, u],
    });
    const call2Payload = buildRawPayload({
      task: task(1),
      systemPromptEntry: sys,
      historyEntries: [sys, u, a1, tr],
    });

    assert.equal(call1Payload.messages.length, 2);
    assert.equal(call2Payload.messages.length, 4);
    assert.equal(call2Payload.messages[2]!.role, "assistant");
    assert.equal(call2Payload.messages[3]!.role, "tool");
  });
});

// ─── HTML overlay wiring ───────────────────────────────────────────────────

describe("renderLlmLogHtml — raw payload overlay", () => {
  it("emits a dialog per LLM call with a button to open it", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "system_prompt", role: "system", content: "SYS" }),
      entry(1, { kind: "user_message", role: "user", content: "hi" }),
      aiMessage(1, "ok"),
      entry(1, { kind: "tool_result", role: "tool", content: "RES", metadata: { toolName: "bash" } }),
      aiMessage(1, "ok again"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    const buttons = html.match(/class="raw-btn"/g) ?? [];
    assert.equal(buttons.length, 2);
    const dialogs = html.match(/<dialog class="raw-dialog"/g) ?? [];
    assert.equal(dialogs.length, 2);
    assert.match(html, /data-dialog="payload-task1-call1"/);
    assert.match(html, /id="payload-task1-call1"/);
    assert.match(html, /data-dialog="payload-task1-call2"/);
    assert.match(html, /id="payload-task1-call2"/);
  });

  it("includes the show/close script", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "user_message", role: "user", content: "x" }),
      aiMessage(1, "y"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    assert.match(html, /<script>/);
    assert.match(html, /showModal/);
    assert.match(html, /raw-dialog-close/);
  });

  it("dialog contains JSON payload for that call", () => {
    nextEntryId = 1;
    const entries = [
      entry(1, { kind: "system_prompt", role: "system", content: "SYS_PROMPT_CONTENT" }),
      entry(1, { kind: "user_message", role: "user", content: "USER_INPUT" }),
      aiMessage(1, "ok"),
    ];
    const html = renderLlmLogHtml({
      session: session(),
      tasks: [task(1)],
      entries,
      generatedAt: new Date(),
    });
    const m = /<dialog class="raw-dialog" id="payload-task1-call1">([\s\S]*?)<\/dialog>/.exec(html);
    assert.ok(m, "dialog block missing");
    const dlg = m![1]!;
    // JSON sits inside a <pre> with HTML-escaped quotes; match either form.
    assert.match(dlg, /(?:"role": "system"|&quot;role&quot;: &quot;system&quot;)/);
    assert.match(dlg, /SYS_PROMPT_CONTENT/);
    assert.match(dlg, /(?:"role": "user"|&quot;role&quot;: &quot;user&quot;)/);
    assert.match(dlg, /USER_INPUT/);
    // Call #1 payload has no assistant message yet.
    assert.doesNotMatch(dlg, /(?:"role": "assistant"|&quot;role&quot;: &quot;assistant&quot;)/);
  });
});
