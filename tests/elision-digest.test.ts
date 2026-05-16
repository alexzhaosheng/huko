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

import {
  buildElidedDigest,
  groupIntoTurns,
  type Turn,
} from "../server/task/pipeline/context-manage.js";
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

// ─── groupIntoTurns — sub-turn unit boundaries ──────────────────────────────
//
// The boundary semantics changed when compaction moved from "user-message
// turns" (too coarse — a single user prompt + 30 assistant iterations =
// 1 turn = nothing droppable) to "assistant-bounded units". Each unit is
// the smallest safe-to-drop slice that still respects the assistant ↔
// tool_result pairing invariant the LLM APIs enforce.
//
// These tests pin the new boundary logic. If anyone reverts to user-only
// boundaries (the old behaviour), compaction stops firing on single-prompt
// heavy-iteration sessions and the regression should surface here.

describe("groupIntoTurns — sub-turn unit boundaries", () => {
  it("splits at every assistant message, not just user-role messages", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: "go",
        _entryId: 1,
        _entryKind: EntryKind.UserMessage,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "f", arguments: {} }],
        _entryId: 2,
        _entryKind: EntryKind.AiMessage,
      },
      {
        role: "tool",
        content: "r1",
        toolCallId: "c1",
        _entryId: 3,
        _entryKind: EntryKind.ToolResult,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "g", arguments: {} }],
        _entryId: 4,
        _entryKind: EntryKind.AiMessage,
      },
      {
        role: "tool",
        content: "r2",
        toolCallId: "c2",
        _entryId: 5,
        _entryKind: EntryKind.ToolResult,
      },
      {
        role: "assistant",
        content: "done",
        _entryId: 6,
        _entryKind: EntryKind.AiMessage,
      },
    ];
    const units = groupIntoTurns(messages, 4);
    // 4 units: [user], [asst+tool], [asst+tool], [asst_final]
    // Under the OLD user-only boundary this was 1 unit (nothing droppable).
    assert.equal(units.length, 4, "single-prompt with 3 assistants → 4 units");

    // Unit 1 is the user_message alone (next msg is assistant, flushes).
    assert.equal(units[0]!.messages.length, 1);
    assert.equal(units[0]!.messages[0]!._entryKind, EntryKind.UserMessage);

    // Units 2 and 3 each carry their assistant + paired tool_result.
    assert.equal(units[1]!.messages.length, 2);
    assert.equal(units[1]!.messages[0]!._entryKind, EntryKind.AiMessage);
    assert.equal(units[1]!.messages[1]!._entryKind, EntryKind.ToolResult);
    assert.equal(units[2]!.messages.length, 2);

    // Unit 4 is the text-only final assistant — no trailing tools.
    assert.equal(units[3]!.messages.length, 1);
    assert.equal(units[3]!.messages[0]!._entryKind, EntryKind.AiMessage);
  });

  it("keeps assistant + ALL its parallel tool_results in the SAME unit", () => {
    // The pairing invariant: assistant.toolCalls=[a,b,c] requires
    // tool_results for a, b, AND c to immediately follow. They must
    // never get split into different units, otherwise dropping one unit
    // breaks the pairing.
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: "x",
        _entryId: 1,
        _entryKind: EntryKind.UserMessage,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "f", arguments: {} },
          { id: "b", name: "g", arguments: {} },
          { id: "c", name: "h", arguments: {} },
        ],
        _entryId: 2,
        _entryKind: EntryKind.AiMessage,
      },
      {
        role: "tool",
        content: "a-result",
        toolCallId: "a",
        _entryId: 3,
        _entryKind: EntryKind.ToolResult,
      },
      {
        role: "tool",
        content: "b-result",
        toolCallId: "b",
        _entryId: 4,
        _entryKind: EntryKind.ToolResult,
      },
      {
        role: "tool",
        content: "c-result",
        toolCallId: "c",
        _entryId: 5,
        _entryKind: EntryKind.ToolResult,
      },
    ];
    const units = groupIntoTurns(messages, 4);
    assert.equal(units.length, 2, "[user] + [asst+3 tools]");
    const tail = units[1]!;
    // Assistant + all 3 tool_results stayed in unit 2.
    assert.equal(tail.messages.length, 4);
    assert.equal(tail.messages[0]!._entryKind, EntryKind.AiMessage);
    assert.equal(tail.messages[1]!._entryKind, EntryKind.ToolResult);
    assert.equal(tail.messages[2]!._entryKind, EntryKind.ToolResult);
    assert.equal(tail.messages[3]!._entryKind, EntryKind.ToolResult);
  });

  it("system_reminder (role=user) starts its own unit between assistants", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: "go",
        _entryId: 1,
        _entryKind: EntryKind.UserMessage,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "f", arguments: {} }],
        _entryId: 2,
        _entryKind: EntryKind.AiMessage,
      },
      {
        role: "tool",
        content: "r1",
        toolCallId: "c1",
        _entryId: 3,
        _entryKind: EntryKind.ToolResult,
      },
      {
        role: "user",
        content: "<system_reminder reason=\"behavior_guard\">…</system_reminder>",
        _entryId: 4,
        _entryKind: EntryKind.SystemReminder,
      },
      {
        role: "assistant",
        content: "ok",
        _entryId: 5,
        _entryKind: EntryKind.AiMessage,
      },
    ];
    const units = groupIntoTurns(messages, 4);
    // [user], [asst+tool], [system_reminder], [asst]
    assert.equal(units.length, 4);
    assert.equal(units[2]!.messages[0]!._entryKind, EntryKind.SystemReminder);
    assert.equal(units[3]!.messages[0]!._entryKind, EntryKind.AiMessage);
  });

  it("a heavy single-prompt task has enough units for compaction to fire", () => {
    // Reproduces HukoTest session 2's shape: 1 user_message followed by
    // many assistant iterations. Under the OLD grouping this was 2
    // turns (1 user + 1 system_reminder boundary), which tripped the
    // `units.length < 3` early-return and made compaction a no-op even
    // with --compact-threshold=0.2. The new grouping produces N+1 units
    // for N assistant iterations, unblocking middle-drop.
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: "do thing",
        _entryId: allocId(),
        _entryKind: EntryKind.UserMessage,
      },
    ];
    for (let i = 0; i < 5; i++) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "browser", arguments: { action: "get_text" } }],
        _entryId: allocId(),
        _entryKind: EntryKind.AiMessage,
      });
      messages.push({
        role: "tool",
        content: `result ${i}`,
        toolCallId: `c${i}`,
        _entryId: allocId(),
        _entryKind: EntryKind.ToolResult,
      });
    }
    const units = groupIntoTurns(messages, 4);
    // 1 (user) + 5 (assistant+tool) = 6 units → ≥ 3 → compaction unblocked.
    assert.equal(units.length, 6);
    assert.ok(units.length >= 3, "compaction's units.length<3 early-return is cleared");
  });
});
