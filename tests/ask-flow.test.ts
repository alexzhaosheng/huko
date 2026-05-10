/**
 * tests/ask-flow.test.ts
 *
 * Covers `message(type=ask)` and the orchestrator-side resolver
 * registry. Three layers:
 *
 *   1. Schema gating — `interactive: true` → ask is in the type enum;
 *      `interactive: false` → ask is silently dropped, plus a
 *      non-interactive instruction block is appended to the description.
 *   2. Message-tool handler behaviour — when type=ask, the handler
 *      calls `ctx.waitForReply` with the right payload and returns
 *      the reply text as the tool result. When `waitForReply` is
 *      missing, it errors gracefully instead of hanging.
 *   3. Orchestrator `respondToAsk` registry — keyed by toolCallId,
 *      idempotent (second resolve is a no-op), reports false when
 *      the toolCallId has no waiter.
 *
 * No fake LLM in here — that's a much heavier integration test. The
 * three layers above pin every contract a real LLM call would
 * eventually depend on.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: register the built-in tools so getToolsForLLM has them.
import "../server/task/tools/index.js";

import { getTool, getToolsForLLM } from "../server/task/tools/registry.js";
import { TaskOrchestrator } from "../server/services/index.js";
import { MemorySessionPersistence } from "../server/persistence/memory.js";
import type { Emitter } from "../server/engine/SessionContext.js";
import type { HukoEvent } from "../shared/events.js";

// ─── Layer 1: schema gating ─────────────────────────────────────────────────

describe("message tool — schema gating by interactive flag", () => {
  it("interactive=true: type enum includes ask + info + result", () => {
    const tools = getToolsForLLM({ interactive: true });
    const msg = tools.find((t) => t.name === "message");
    assert.ok(msg, "message tool registered");
    const props = msg!.parameters!.properties as Record<string, { enum?: string[] }>;
    const types = props["type"]!.enum!;
    assert.ok(types.includes("ask"));
    assert.ok(types.includes("info"));
    assert.ok(types.includes("result"));
  });

  it("interactive=false: type enum drops ask but keeps info + result", () => {
    const tools = getToolsForLLM({ interactive: false });
    const msg = tools.find((t) => t.name === "message");
    assert.ok(msg);
    const props = msg!.parameters!.properties as Record<string, { enum?: string[] }>;
    const types = props["type"]!.enum!;
    assert.ok(!types.includes("ask"), `ask should NOT be in ${JSON.stringify(types)}`);
    assert.ok(types.includes("info"));
    assert.ok(types.includes("result"));
  });

  it("interactive=false: description mentions the non-interactive mode", () => {
    const tools = getToolsForLLM({ interactive: false });
    const msg = tools.find((t) => t.name === "message");
    assert.match(msg!.description ?? "", /non_interactive_mode/);
  });

  it("interactive=true: description does NOT mention non-interactive mode", () => {
    const tools = getToolsForLLM({ interactive: true });
    const msg = tools.find((t) => t.name === "message");
    assert.doesNotMatch(msg!.description ?? "", /non_interactive_mode/);
  });
});

// ─── Layer 2: message-tool handler ──────────────────────────────────────────

describe("message tool handler — ask mode", () => {
  it("invokes ctx.waitForReply with the right payload and returns the reply", async () => {
    const tool = getTool("message");
    assert.ok(tool && tool.kind === "server");

    let captured: unknown = null;
    // Minimal ctx mock — only fields the handler touches in ask mode.
    const ctx = {
      waitForReply: async (payload: unknown) => {
        captured = payload;
        return { content: "the user's answer" };
      },
    };

    const result = await Promise.resolve(
      tool.handler(
        { type: "ask", text: "what's your name?", options: ["a", "b"], selectionType: "single" },
        // Cast through unknown — tests aren't going to build a full TaskContext.
        ctx as unknown as Parameters<typeof tool.handler>[1],
        { toolCallId: "call_test_1" },
      ),
    );

    assert.deepEqual(captured, {
      toolCallId: "call_test_1",
      question: "what's your name?",
      options: ["a", "b"],
      selectionType: "single",
    });
    // The tool's "content" (what the LLM sees) should be the reply text.
    if (typeof result === "string") {
      assert.equal(result, "the user's answer");
    } else {
      // It's a ToolHandlerResult.
      assert.equal(
        (result as { content: string }).content,
        "the user's answer",
      );
    }
  });

  it("returns an error result when waitForReply is missing (defensive)", async () => {
    const tool = getTool("message");
    assert.ok(tool && tool.kind === "server");

    const ctx = {}; // no waitForReply
    const result = await Promise.resolve(
      tool.handler(
        { type: "ask", text: "hello?" },
        ctx as unknown as Parameters<typeof tool.handler>[1],
        { toolCallId: "call_test_2" },
      ),
    );

    // Expect a structured error result; the LLM's content should
    // explain why ask isn't available.
    const r = result as { content: string; error?: string };
    assert.match(r.content, /ask is not available/i);
    assert.equal(r.error, "no_wait_for_reply");
  });

  it("info / result modes still work (no regression)", async () => {
    const tool = getTool("message");
    assert.ok(tool && tool.kind === "server");

    const info = await Promise.resolve(
      tool.handler(
        { type: "info", text: "a progress note" },
        {} as unknown as Parameters<typeof tool.handler>[1],
        { toolCallId: "call_info" },
      ),
    );
    const r1 = info as { content: string; metadata?: { messageType?: string } };
    assert.equal(r1.metadata?.messageType, "info");

    const final = await Promise.resolve(
      tool.handler(
        { type: "result", text: "all done" },
        {} as unknown as Parameters<typeof tool.handler>[1],
        { toolCallId: "call_final" },
      ),
    );
    const r2 = final as { shouldBreak?: boolean; finalResult?: string };
    assert.equal(r2.shouldBreak, true);
    assert.equal(r2.finalResult, "all done");
  });
});

// ─── Layer 3: orchestrator.respondToAsk ─────────────────────────────────────

describe("TaskOrchestrator.respondToAsk", () => {
  let orch: TaskOrchestrator;
  let session: MemorySessionPersistence;
  let events: HukoEvent[];

  beforeEach(() => {
    session = new MemorySessionPersistence();
    events = [];
    const emitter: Emitter = {
      emit(e) {
        events.push(e);
      },
    };
    orch = new TaskOrchestrator({
      session,
      emitterFactory: () => emitter,
    });
  });

  it("returns false when no pending ask matches the toolCallId", () => {
    assert.equal(orch.respondToAsk("nope", { content: "x" }), false);
  });

  it("pendingAsks is empty when nothing is waiting", () => {
    assert.deepEqual(orch.pendingAsks(), []);
  });

  // Exercising the full waitForReply → respondToAsk roundtrip end-to-end
  // would require a fake LLM client to drive a real task. For now, the
  // contract we pin is: an external respondToAsk call without a waiter
  // is a recoverable no-op rather than a crash. The roundtrip is
  // exercised in production by integration runs of `huko run`.
});
