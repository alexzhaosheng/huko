/**
 * tests/resume.test.ts
 *
 * recoverOrphans — orchestrator startup heals tasks left non-terminal
 * by a previous crashed/killed process. Three checkpoint shapes:
 *   1. running with dangling tool_calls   → synthesise tool_results, mark failed
 *   2. waiting_for_reply                  → mark failed
 *   3. waiting_for_approval               → mark failed
 *
 * Plus: terminal tasks ignored, idempotency, RecoveryReport accuracy.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { MemorySessionPersistence } from "../server/persistence/memory.js";
import { recoverOrphans } from "../server/task/resume.js";
import { EntryKind } from "../shared/types.js";

let s: MemorySessionPersistence;

beforeEach(() => {
  s = new MemorySessionPersistence();
});

function taskSpec(chatSessionId: number, status: "running" | "done" | "failed" | "waiting_for_reply" | "waiting_for_approval" | "stopped" | "pending") {
  return {
    chatSessionId,
    agentSessionId: null,
    modelId: "anthropic/claude-sonnet-4.5",
    toolCallMode: "native" as const,
    thinkLevel: "off" as const,
    status,
  };
}

describe("recoverOrphans — running task with dangling tool_calls", () => {
  it("injects synthetic tool_result rows and marks the task failed", async () => {
    const sid = await s.sessions.create({ title: "x" });
    const tid = await s.tasks.create(taskSpec(sid, "running"));
    // Assistant emitted two tool_calls, only one returned.
    await s.entries.persist({
      taskId: tid, sessionId: sid, sessionType: "chat",
      kind: EntryKind.AiMessage, role: "assistant", content: "thinking…",
      metadata: { toolCalls: [{ id: "call_1" }, { id: "call_2" }] },
    });
    await s.entries.persist({
      taskId: tid, sessionId: sid, sessionType: "chat",
      kind: EntryKind.ToolResult, role: "tool", content: "r1",
      toolCallId: "call_1",
    });

    const report = await recoverOrphans(s);

    assert.equal(report.scanned, 1);
    assert.equal(report.healed, 1);
    assert.equal(report.byKind.danglingTools, 1);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]!.taskId, tid);
    assert.equal(report.records[0]!.danglingToolCount, 1);
    assert.match(report.records[0]!.reason, /synthetic tool_result/);

    // Task moved to failed
    const after = await s.tasks.get(tid);
    assert.equal(after!.status, "failed");
    assert.match(after!.errorMessage ?? "", /synthetic tool_result/);

    // Synthetic tool_result row exists for call_2
    const rows = await s.entries.listForSession(sid, "chat");
    const synthetic = rows.find(
      (r) => r.kind === EntryKind.ToolResult && r.toolCallId === "call_2",
    );
    assert.ok(synthetic, "synthetic tool_result for call_2 should exist");
    const meta = synthetic!.metadata as Record<string, unknown>;
    assert.equal(meta["synthetic"], true);
    assert.equal(meta["error"], "interrupted");
    assert.match(synthetic!.content, /interrupted by process termination/);
  });

  it("running task with NO dangling tool_calls — no inject, mark failed", async () => {
    const sid = await s.sessions.create({ title: "x" });
    const tid = await s.tasks.create(taskSpec(sid, "running"));
    // assistant turn fully closed
    await s.entries.persist({
      taskId: tid, sessionId: sid, sessionType: "chat",
      kind: EntryKind.AiMessage, role: "assistant", content: "ok",
      metadata: { toolCalls: [{ id: "call_1" }] },
    });
    await s.entries.persist({
      taskId: tid, sessionId: sid, sessionType: "chat",
      kind: EntryKind.ToolResult, role: "tool", content: "r",
      toolCallId: "call_1",
    });

    const report = await recoverOrphans(s);
    assert.equal(report.healed, 1);
    assert.equal(report.byKind.danglingTools, 0);
    assert.equal(report.byKind.other, 1);
    assert.equal(report.records[0]!.danglingToolCount, 0);
    assert.equal((await s.tasks.get(tid))!.status, "failed");
  });
});

describe("recoverOrphans — waiting_for_reply / waiting_for_approval", () => {
  it("waiting_for_reply → mark failed, byKind.waitingForReply++", async () => {
    const sid = await s.sessions.create({ title: "x" });
    const tid = await s.tasks.create(taskSpec(sid, "waiting_for_reply"));
    const report = await recoverOrphans(s);
    assert.equal(report.byKind.waitingForReply, 1);
    assert.equal(report.byKind.danglingTools, 0);
    assert.equal(report.records[0]!.taskId, tid);
    assert.match(report.records[0]!.reason, /waiting for user reply/);
    assert.equal((await s.tasks.get(tid))!.status, "failed");
  });

  it("waiting_for_approval → mark failed, byKind.waitingForApproval++", async () => {
    const sid = await s.sessions.create({ title: "x" });
    const tid = await s.tasks.create(taskSpec(sid, "waiting_for_approval"));
    const report = await recoverOrphans(s);
    assert.equal(report.byKind.waitingForApproval, 1);
    assert.match(report.records[0]!.reason, /waiting for approval/);
    assert.equal((await s.tasks.get(tid))!.status, "failed");
  });
});

describe("recoverOrphans — terminal tasks are ignored", () => {
  it("done/failed/stopped tasks aren't touched", async () => {
    const sid = await s.sessions.create({ title: "x" });
    const done    = await s.tasks.create(taskSpec(sid, "done"));
    const failed  = await s.tasks.create(taskSpec(sid, "failed"));
    const stopped = await s.tasks.create(taskSpec(sid, "stopped"));

    const report = await recoverOrphans(s);
    assert.equal(report.scanned, 0);
    assert.equal(report.healed, 0);
    assert.equal(report.records.length, 0);

    // Statuses unchanged
    assert.equal((await s.tasks.get(done))!.status,    "done");
    assert.equal((await s.tasks.get(failed))!.status,  "failed");
    assert.equal((await s.tasks.get(stopped))!.status, "stopped");
  });
});

describe("recoverOrphans — idempotency", () => {
  it("running again is a no-op (everything is already terminal)", async () => {
    const sid = await s.sessions.create({ title: "x" });
    await s.tasks.create(taskSpec(sid, "waiting_for_reply"));
    await s.tasks.create(taskSpec(sid, "running"));

    const first = await recoverOrphans(s);
    assert.equal(first.healed, 2);

    const second = await recoverOrphans(s);
    assert.equal(second.scanned, 0);
    assert.equal(second.healed, 0);
    assert.deepEqual(second.records, []);
  });
});

describe("recoverOrphans — multi-task report aggregation", () => {
  it("counts each kind separately and emits one record per healed task", async () => {
    const sid = await s.sessions.create({ title: "x" });

    // running w/ dangling
    const t1 = await s.tasks.create(taskSpec(sid, "running"));
    await s.entries.persist({
      taskId: t1, sessionId: sid, sessionType: "chat",
      kind: EntryKind.AiMessage, role: "assistant", content: "?",
      metadata: { toolCalls: [{ id: "c1" }] },
    });
    // running w/o dangling
    await s.tasks.create(taskSpec(sid, "running"));
    // waiting_for_reply
    await s.tasks.create(taskSpec(sid, "waiting_for_reply"));
    // waiting_for_approval
    await s.tasks.create(taskSpec(sid, "waiting_for_approval"));

    const report = await recoverOrphans(s);
    assert.equal(report.scanned, 4);
    assert.equal(report.healed, 4);
    assert.equal(report.byKind.danglingTools, 1);
    assert.equal(report.byKind.waitingForReply, 1);
    assert.equal(report.byKind.waitingForApproval, 1);
    assert.equal(report.byKind.other, 1);
    assert.equal(report.records.length, 4);
    // Every record should reference a unique taskId
    const taskIds = new Set(report.records.map((r) => r.taskId));
    assert.equal(taskIds.size, 4);
  });
});
