/**
 * tests/elision-digest.test.ts
 *
 * Compaction's structured `<elided_summary>` digest — pure unit tests
 * on `buildElidedDigest` with handcrafted Turn fixtures.
 *
 * Coverage:
 *   - User-message turns appear verbatim in the digest
 *   - Multiple user messages in dropped range all show up (no "pin one,
 *     drop the rest" — the digest is the full goal trail)
 *   - Assistant tool calls become one `<tool>` line per call
 *   - tool_results are dropped (recoverable by re-read)
 *   - SystemReminder turns are dropped (low post-compaction value)
 *   - Pure-reasoning assistant turns are dropped
 *   - User content longer than 2k chars is truncated with ellipsis
 *   - Tool args longer than 80 chars per value are truncated
 *   - XML-sensitive characters in content are escaped (no tag injection)
 *   - Empty dropped range → empty string (caller skips wrapper)
 *
 * This locks the digest format so future planner changes don't silently
 * regress what the model sees about elided history.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { buildElidedDigest, type Turn } from "../server/task/pipeline/context-manage.js";
import { EntryKind } from "../shared/types.js";
import type { LLMMessage } from "../server/core/llm/types.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

let nextEntryId = 1;
const allocId = (): number => nextEntryId++;

function userTurn(content: string): Turn {
  return {
    messages: [
      {
        role: "user",
        content,
        _entryId: allocId(),
        _entryKind: EntryKind.UserMessage,
      },
    ],
    approxTokens: Math.ceil(content.length / 4) + 8,
  };
}

function reminderTurn(reason: string, content: string): Turn {
  const wrapped = `<system_reminder reason="${reason}">${content}</system_reminder>`;
  return {
    messages: [
      {
        role: "user",
        content: wrapped,
        _entryId: allocId(),
        _entryKind: EntryKind.SystemReminder,
      },
    ],
    approxTokens: Math.ceil(wrapped.length / 4) + 8,
  };
}

function toolCallTurn(
  userPrompt: string,
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  toolResults: Array<{ callId: string; content: string }>,
): Turn {
  const assistant: LLMMessage = {
    role: "assistant",
    content: "",
    toolCalls: toolCalls.map((tc, i) => ({
      id: `call_${i}`,
      name: tc.name,
      arguments: tc.args,
    })),
    _entryId: allocId(),
    _entryKind: EntryKind.AiMessage,
  };
  const tools: LLMMessage[] = toolResults.map((tr) => ({
    role: "tool",
    content: tr.content,
    toolCallId: tr.callId,
    _entryId: allocId(),
    _entryKind: EntryKind.ToolResult,
  }));
  const userMsg: LLMMessage = {
    role: "user",
    content: userPrompt,
    _entryId: allocId(),
    _entryKind: EntryKind.UserMessage,
  };
  return {
    messages: [userMsg, assistant, ...tools],
    approxTokens: 100,
  };
}

function reasoningTurn(prompt: string, thinking: string): Turn {
  return {
    messages: [
      {
        role: "user",
        content: prompt,
        _entryId: allocId(),
        _entryKind: EntryKind.UserMessage,
      },
      {
        role: "assistant",
        content: "ok",
        thinking,
        _entryId: allocId(),
        _entryKind: EntryKind.AiMessage,
      },
    ],
    approxTokens: 50,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildElidedDigest — basic shape", () => {
  it("returns empty string when there's nothing goal-bearing", () => {
    const turns = [reminderTurn("compaction_done", "earlier elision")];
    assert.equal(buildElidedDigest(turns), "");
  });

  it("returns empty string for an empty dropped range", () => {
    assert.equal(buildElidedDigest([]), "");
  });

  it("wraps content in <elided_summary>...</elided_summary>", () => {
    const turns = [userTurn("evaluate this project")];
    const out = buildElidedDigest(turns);
    assert.match(out, /^<elided_summary>/);
    assert.match(out, /<\/elided_summary>$/);
  });
});

describe("buildElidedDigest — user_message preservation (THE BUG)", () => {
  it("includes EVERY elided user_message verbatim", () => {
    const turns = [
      userTurn("评价一下这个项目，你觉得这个项目最大的特点和卖点是什么？"),
      toolCallTurn(
        "read more files",
        [{ name: "read_file", args: { path: "README.md" } }],
        [{ callId: "call_0", content: "[file content]" }],
      ),
      userTurn("检查一下huko的代码，看看还有什么地方可以优化？"),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes("评价一下这个项目"), "first user goal missing");
    assert.ok(out.includes("检查一下huko的代码"), "second user goal missing");
  });

  it("emits user messages as <user_message> tags", () => {
    const turns = [userTurn("hello")];
    const out = buildElidedDigest(turns);
    assert.match(out, /<user_message>hello<\/user_message>/);
  });

  it("truncates user content at 2000 chars with ellipsis", () => {
    const longContent = "x".repeat(5000);
    const turns = [userTurn(longContent)];
    const out = buildElidedDigest(turns);
    const matches = out.match(/<user_message>(.*?)<\/user_message>/s);
    assert.ok(matches);
    const body = matches![1]!;
    assert.equal(body.length, 2000);
    assert.equal(body[body.length - 1], "…");
  });

  it("escapes XML-sensitive characters in user content", () => {
    const turns = [userTurn(`<script>alert("xss")</script> & </user_message>`)];
    const out = buildElidedDigest(turns);

    const bodyMatch = out.match(/<user_message>([\s\S]*?)<\/user_message>/);
    assert.ok(bodyMatch, "no user_message element found");
    const body = bodyMatch![1]!;
    assert.ok(!body.includes("</user_message>"), "raw closing tag inside body would break structure");
    assert.ok(!body.includes("<script>"));

    assert.ok(body.includes("&lt;script&gt;"));
    assert.ok(body.includes("&amp;"));
    assert.ok(body.includes("&quot;xss&quot;"));
    assert.ok(body.includes("&lt;/user_message&gt;"));

    const closingTags = out.match(/<\/user_message>/g) ?? [];
    assert.equal(closingTags.length, 1, "exactly one closing tag expected");
  });
});

describe("buildElidedDigest — tool calls", () => {
  it("emits one <tool> line per call in an assistant turn", () => {
    const turns = [
      toolCallTurn(
        "do stuff",
        [
          { name: "read_file", args: { path: "a.ts" } },
          { name: "grep", args: { pattern: "compaction" } },
        ],
        [
          { callId: "call_0", content: "[content]" },
          { callId: "call_1", content: "[hits]" },
        ],
      ),
    ];
    const out = buildElidedDigest(turns);
    const toolLines = out.match(/<tool [^>]*>/g) ?? [];
    assert.equal(toolLines.length, 2);
    assert.ok(out.includes('<tool name="read_file">'));
    assert.ok(out.includes('<tool name="grep">'));
  });

  it("renders args as k=v space-separated", () => {
    const turns = [
      toolCallTurn(
        "stuff",
        [{ name: "bash", args: { cmd: "npm test", cwd: "/tmp" } }],
        [{ callId: "call_0", content: "[ok]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes("cmd=npm test"));
    assert.ok(out.includes("cwd=/tmp"));
  });

  it("truncates long arg values at 80 chars per value", () => {
    const turns = [
      toolCallTurn(
        "write a big file",
        [
          {
            name: "write_file",
            args: { path: "foo.txt", content: "y".repeat(500) },
          },
        ],
        [{ callId: "call_0", content: "[written]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes("path=foo.txt"));
    assert.match(out, /content=y{79}…/);
    assert.ok(!out.includes("y".repeat(500)));
  });

  it("self-closes when a tool call has no args", () => {
    const turns = [
      toolCallTurn(
        "noop",
        [{ name: "ping", args: {} }],
        [{ callId: "call_0", content: "[pong]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes('<tool name="ping"/>'));
  });

  it("escapes the tool name in case of weird characters", () => {
    const turns = [
      toolCallTurn(
        "x",
        [{ name: `bad"name<>`, args: {} }],
        [{ callId: "call_0", content: "[r]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(!out.includes(`bad"name<>`));
    assert.ok(out.includes("bad&quot;name&lt;&gt;"));
  });

  it("stringifies non-string arg values", () => {
    const turns = [
      toolCallTurn(
        "x",
        [
          {
            name: "set",
            args: { n: 42, flag: true, list: [1, 2, 3] },
          },
        ],
        [{ callId: "call_0", content: "[r]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes("n=42"));
    assert.ok(out.includes("flag=true"));
    assert.ok(out.includes("list=[1,2,3]"));
  });
});

describe("buildElidedDigest — what's dropped", () => {
  it("drops tool_result messages (re-readable)", () => {
    const turns = [
      toolCallTurn(
        "read",
        [{ name: "read_file", args: { path: "a.ts" } }],
        [{ callId: "call_0", content: "[GIANT FILE CONTENT]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    assert.ok(!out.includes("GIANT FILE CONTENT"));
  });

  it("drops pure-reasoning assistant turns", () => {
    const turns = [reasoningTurn("ponder", "lots of thinking...")];
    const out = buildElidedDigest(turns);
    assert.ok(out.includes("<user_message>ponder</user_message>"));
    assert.ok(!out.includes("lots of thinking"));
  });

  it("drops system_reminder turns", () => {
    const turns = [reminderTurn("info_ack", "you ran message info")];
    const out = buildElidedDigest(turns);
    assert.equal(out, "");
  });
});

describe("buildElidedDigest — interleaved sequence", () => {
  it("preserves chronological order of user goals + tool calls", () => {
    const turns = [
      userTurn("evaluate"),
      toolCallTurn(
        "_",
        [{ name: "read_file", args: { path: "a.ts" } }],
        [{ callId: "call_0", content: "[r]" }],
      ),
      userTurn("now optimise"),
      toolCallTurn(
        "_",
        [{ name: "grep", args: { pattern: "compaction" } }],
        [{ callId: "call_0", content: "[hits]" }],
      ),
    ];
    const out = buildElidedDigest(turns);
    const evalIdx = out.indexOf("evaluate");
    const readIdx = out.indexOf('name="read_file"');
    const optIdx = out.indexOf("now optimise");
    const grepIdx = out.indexOf('name="grep"');
    assert.ok(evalIdx >= 0);
    assert.ok(readIdx > evalIdx);
    assert.ok(optIdx > readIdx);
    assert.ok(grepIdx > optIdx);
  });
});
