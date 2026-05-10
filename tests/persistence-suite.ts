/**
 * tests/persistence-suite.ts
 *
 * Shared spec for `SessionPersistence` so the SQLite and Memory
 * backends are tested by literally the same code,
 * not two parallel copies. Add a behavioural test once, both backends
 * inherit it.
 *
 * Each backend test file calls `runInfraSuite` / `runSessionSuite` with
 * a factory:
 *
 *   runSessionSuite("memory", () => ({
 *     instance: new MemorySessionPersistence(),
 *     teardown: () => {},
 *   }));
 *
 * SQLite-only behaviour (transaction rollback under failure, on-disk
 * artifacts) stays in the SQLite test file — not every contract is
 * shared, only the behavioural one.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import type { SessionPersistence } from "../server/persistence/index.js";
import { EntryKind, type TaskStatus } from "../shared/types.js";

// A factory's return: the backend instance + a teardown to call
// after each test. Teardown is the place to close DB handles, drop
// tmp directories, etc.
export type Harness<T> = {
  instance: T;
  teardown: () => Promise<void> | void;
};

export type SessionFactory = () => Harness<SessionPersistence>;

// ─── Session suite ──────────────────────────────────────────────────────────

export function runSessionSuite(label: string, factory: SessionFactory): void {
  function taskSpec(chatSessionId: number, status: TaskStatus = "running") {
    return {
      chatSessionId,
      agentSessionId: null,
      modelId: "anthropic/claude-sonnet-4.5",
      toolCallMode: "native" as const,
      thinkLevel: "off" as const,
      status,
    };
  }

  describe(`SessionPersistence — ${label}`, () => {
    let session: SessionPersistence;
    let teardown: () => Promise<void> | void;

    beforeEach(() => {
      const h = factory();
      session = h.instance;
      teardown = h.teardown;
    });
    afterEach(async () => {
      await teardown();
    });

    describe("sessions", () => {
      it("create + get + list round trip", async () => {
        const id = await session.sessions.create({ title: "first" });
        const got = await session.sessions.get(id);
        assert.ok(got);
        assert.equal(got!.id, id);
        assert.equal(got!.title, "first");

        const all = await session.sessions.list();
        assert.equal(all.length, 1);
        assert.equal(all[0]!.id, id);
      });

      it("create with no title defaults to empty string", async () => {
        const id = await session.sessions.create({});
        const got = await session.sessions.get(id);
        assert.equal(got!.title, "");
      });

      it("get returns null for unknown id", async () => {
        assert.equal(await session.sessions.get(99_999), null);
      });

      it("list returns every persisted session", async () => {
        // We don't assert *order* — both backends quantise updatedAt
        // (SQLite to seconds, Memory to ms-but-flaky-on-Windows), so
        // back-to-back inserts can tie. Order across a second is
        // implicit; here we just verify membership.
        const a = await session.sessions.create({ title: "a" });
        const b = await session.sessions.create({ title: "b" });
        const ids = (await session.sessions.list())
          .map((r) => r.id)
          .sort((x, y) => x - y);
        assert.deepEqual(ids, [a, b].sort((x, y) => x - y));
      });

      it("delete removes the session", async () => {
        const id = await session.sessions.create({ title: "x" });
        await session.sessions.delete(id);
        assert.equal(await session.sessions.get(id), null);
        assert.deepEqual(await session.sessions.list(), []);
      });

      it("delete cascades into tasks and entries", async () => {
        const sid = await session.sessions.create({ title: "x" });
        const tid = await session.tasks.create(taskSpec(sid));
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "hi",
        });
        await session.sessions.delete(sid);
        assert.equal(await session.tasks.get(tid), null);
        assert.deepEqual(
          await session.entries.listForSession(sid, "chat"),
          [],
        );
      });
    });

    describe("tasks", () => {
      it("create + get round trip", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const got = await session.tasks.get(tid);
        assert.ok(got);
        assert.equal(got!.chatSessionId, sid);
        assert.equal(got!.modelId, "anthropic/claude-sonnet-4.5");
        assert.equal(got!.status, "running");
        assert.equal(got!.promptTokens, 0);
      });

      it("update applies a partial patch and bumps updatedAt", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const before = (await session.tasks.get(tid))!;
        await new Promise((r) => setTimeout(r, 5));
        await session.tasks.update(tid, {
          status: "done",
          finalResult: "ok",
          promptTokens: 100,
        });
        const after = (await session.tasks.get(tid))!;
        assert.equal(after.status, "done");
        assert.equal(after.finalResult, "ok");
        assert.equal(after.promptTokens, 100);
        assert.ok(after.updatedAt >= before.updatedAt);
      });

      it("listNonTerminal omits done/failed/stopped", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const running  = await session.tasks.create(taskSpec(sid, "running"));
        const pending  = await session.tasks.create(taskSpec(sid, "pending"));
        const waiting1 = await session.tasks.create(taskSpec(sid, "waiting_for_reply"));
        const waiting2 = await session.tasks.create(taskSpec(sid, "waiting_for_approval"));
        const done     = await session.tasks.create(taskSpec(sid, "done"));
        const failed   = await session.tasks.create(taskSpec(sid, "failed"));
        const stopped  = await session.tasks.create(taskSpec(sid, "stopped"));

        const ids = (await session.tasks.listNonTerminal())
          .map((r) => r.id)
          .sort((a, b) => a - b);
        const expected = [running, pending, waiting1, waiting2].sort((a, b) => a - b);
        assert.deepEqual(ids, expected);
        assert.ok(!ids.includes(done));
        assert.ok(!ids.includes(failed));
        assert.ok(!ids.includes(stopped));
      });
    });

    describe("entries", () => {
      it("persist returns an id and listForSession returns the row", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const eid = await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "hi",
        });
        assert.ok(eid > 0);
        const rows = await session.entries.listForSession(sid, "chat");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.id, eid);
        assert.equal(rows[0]!.content, "hi");
        assert.equal(rows[0]!.role, "user");
      });

      it("persist preserves toolCallId / thinking / metadata", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.ToolResult, role: "tool",
          content: "result",
          toolCallId: "call_abc",
          thinking: "reasoning",
          metadata: { toolName: "shell", ok: true },
        });
        const rows = await session.entries.listForSession(sid, "chat");
        assert.equal(rows[0]!.toolCallId, "call_abc");
        assert.equal(rows[0]!.thinking, "reasoning");
        assert.deepEqual(rows[0]!.metadata, { toolName: "shell", ok: true });
      });

      it("listForSession scopes by sessionId AND sessionType", async () => {
        const sidA = await session.sessions.create({ title: "a" });
        const sidB = await session.sessions.create({ title: "b" });
        const tA = await session.tasks.create(taskSpec(sidA));
        const tB = await session.tasks.create(taskSpec(sidB));
        await session.entries.persist({
          taskId: tA, sessionId: sidA, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "in A",
        });
        await session.entries.persist({
          taskId: tB, sessionId: sidB, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "in B",
        });
        const inA = await session.entries.listForSession(sidA, "chat");
        assert.equal(inA.length, 1);
        assert.equal(inA[0]!.content, "in A");
      });

      it("update merges metadata when mergeMetadata=true", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const eid = await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.AiMessage, role: "assistant", content: "ok",
          metadata: { a: 1, b: 2 },
        });
        await session.entries.update(eid, {
          metadata: { b: 99, c: 3 },
          mergeMetadata: true,
        });
        const row = (await session.entries.listForSession(sid, "chat"))[0]!;
        assert.deepEqual(row.metadata, { a: 1, b: 99, c: 3 });
      });

      it("update replaces metadata when mergeMetadata is absent", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const eid = await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.AiMessage, role: "assistant", content: "ok",
          metadata: { a: 1, b: 2 },
        });
        await session.entries.update(eid, { metadata: { c: 3 } });
        const row = (await session.entries.listForSession(sid, "chat"))[0]!;
        assert.deepEqual(row.metadata, { c: 3 });
      });
    });

    describe("loadLLMContext", () => {
      it("includes LLM-visible kinds in id order", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.SystemPrompt, role: "system", content: "you are huko",
        });
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "hi",
        });
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.AiMessage, role: "assistant", content: "hello",
        });
        const ctx = await session.entries.loadLLMContext(sid, "chat");
        const contents = ctx.map((m) => m.content);
        assert.deepEqual(contents, ["you are huko", "hi", "hello"]);
      });

      it("excludes status_notice (UI-only kind)", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "hi",
        });
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.StatusNotice, role: "system", content: "[notice]",
        });
        const ctx = await session.entries.loadLLMContext(sid, "chat");
        assert.equal(ctx.length, 1);
        assert.equal(ctx[0]!.content, "hi");
      });

      it("drops entries listed in a compaction-done elidedEntryIds", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const tid = await session.tasks.create(taskSpec(sid));
        const droppedId = await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "OLD",
        });
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.UserMessage, role: "user", content: "KEEP",
        });
        await session.entries.persist({
          taskId: tid, sessionId: sid, sessionType: "chat",
          kind: EntryKind.SystemReminder, role: "system",
          content: "compacted",
          metadata: {
            reminderReason: "compaction_done",
            elidedEntryIds: [droppedId],
          },
        });
        const ctx = await session.entries.loadLLMContext(sid, "chat");
        const contents = ctx.map((m) => m.content);
        assert.ok(
          !contents.includes("OLD"),
          `OLD should be elided; got ${JSON.stringify(contents)}`,
        );
        assert.ok(contents.includes("KEEP"));
      });
    });

    describe("createWithInitialEntry", () => {
      it("creates the task row AND its initial entry in one shot", async () => {
        const sid = await session.sessions.create({ title: "s" });
        const { taskId, entryId } = await session.tasks.createWithInitialEntry({
          task: taskSpec(sid),
          entry: {
            sessionId: sid, sessionType: "chat",
            kind: EntryKind.UserMessage, role: "user",
            content: "first message",
          },
        });
        assert.ok(taskId > 0);
        assert.ok(entryId > 0);

        const t = await session.tasks.get(taskId);
        assert.ok(t);
        assert.equal(t!.status, "running");

        const rows = await session.entries.listForSession(sid, "chat");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.id, entryId);
        assert.equal(rows[0]!.taskId, taskId);
        assert.equal(rows[0]!.content, "first message");
      });

      it("returns ids that match what's actually persisted", async () => {
        // Regression guard for the SQLite `unknown as { id }` cast —
        // verifies the cast lines up with what tasks.get / listForSession
        // read back.
        const sid = await session.sessions.create({ title: "s" });
        const { taskId, entryId } = await session.tasks.createWithInitialEntry({
          task: taskSpec(sid),
          entry: {
            sessionId: sid, sessionType: "chat",
            kind: EntryKind.UserMessage, role: "user", content: "x",
          },
        });
        const t = await session.tasks.get(taskId);
        assert.equal(t!.id, taskId);
        const rows = await session.entries.listForSession(sid, "chat");
        assert.equal(rows.find((r) => r.id === entryId)?.taskId, taskId);
      });
    });
  });
}
