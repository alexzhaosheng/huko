/**
 * tests/sqlite-session.test.ts
 *
 * Runs the shared `runSessionSuite` against `SqliteSessionPersistence`.
 *
 * Plus a SQLite-only block: `createWithInitialEntry — transaction
 * rollback`. Memory's version is naturally atomic (single-thread, two
 * synchronous map sets), but SQLite's lives inside `db.transaction(...)`
 * — and the whole point of putting it there is that a partial failure
 * mid-transaction must roll back BOTH inserts. We trigger that failure
 * by feeding `metadata` a circular reference: the entry insert's
 * `JSON.stringify` throws inside the txn, and SQLite must bail out
 * with neither row persisted.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionPersistence } from "../server/persistence/sqlite-session.js";
import { EntryKind } from "../shared/types.js";
import { runSessionSuite } from "./persistence-suite.js";

runSessionSuite("sqlite", () => {
  const tmp = mkdtempSync(join(tmpdir(), "huko-session-test-"));
  const instance = new SqliteSessionPersistence({ dbPath: join(tmp, "huko.db") });
  return {
    instance,
    teardown: () => {
      instance.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
});

// ─── SQLite-specific: transaction rollback ──────────────────────────────────

describe("SqliteSessionPersistence — createWithInitialEntry rollback", () => {
  let tmp: string;
  let session: SqliteSessionPersistence;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "huko-session-rollback-"));
    session = new SqliteSessionPersistence({ dbPath: join(tmp, "huko.db") });
  });
  afterEach(() => {
    session.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rolls back BOTH inserts when the entry insert throws inside the txn", async () => {
    const sid = await session.sessions.create({ title: "rollback" });

    // Drizzle serialises `metadata` (mode: "json") via JSON.stringify
    // before the INSERT. A circular ref makes that throw — which is
    // exactly the "partial failure mid-transaction" case we want to
    // verify rolls back atomically.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    await assert.rejects(
      () =>
        session.tasks.createWithInitialEntry({
          task: {
            chatSessionId: sid,
            agentSessionId: null,
            modelId: "anthropic/claude-sonnet-4.5",
            toolCallMode: "native",
            thinkLevel: "off",
            status: "running",
          },
          entry: {
            sessionId: sid,
            sessionType: "chat",
            kind: EntryKind.UserMessage,
            role: "user",
            content: "should not persist",
            metadata: circular,
          },
        }),
      /circular|JSON/i,
    );

    // The tasks INSERT in the txn ran first; its row must be rolled
    // back along with the failing entry INSERT.
    assert.deepEqual(
      await session.tasks.listNonTerminal(),
      [],
      "task row should be rolled back",
    );
    assert.deepEqual(
      await session.entries.listForSession(sid, "chat"),
      [],
      "entry row should never have been written",
    );
  });

  it("a successful create after a rolled-back create starts from a clean slate", async () => {
    const sid = await session.sessions.create({ title: "after-rollback" });

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await assert.rejects(() =>
      session.tasks.createWithInitialEntry({
        task: {
          chatSessionId: sid,
          agentSessionId: null,
          modelId: "anthropic/claude-sonnet-4.5",
          toolCallMode: "native",
          thinkLevel: "off",
          status: "running",
        },
        entry: {
          sessionId: sid,
          sessionType: "chat",
          kind: EntryKind.UserMessage,
          role: "user",
          content: "rolled back",
          metadata: circular,
        },
      }),
    );

    // Now do a healthy create — it must succeed and be the only
    // task/entry around.
    const { taskId, entryId } = await session.tasks.createWithInitialEntry({
      task: {
        chatSessionId: sid,
        agentSessionId: null,
        modelId: "anthropic/claude-sonnet-4.5",
        toolCallMode: "native",
        thinkLevel: "off",
        status: "running",
      },
      entry: {
        sessionId: sid,
        sessionType: "chat",
        kind: EntryKind.UserMessage,
        role: "user",
        content: "this one persists",
      },
    });

    const t = await session.tasks.get(taskId);
    assert.ok(t, "successful task should exist");
    const rows = await session.entries.listForSession(sid, "chat");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, entryId);
    assert.equal(rows[0]!.content, "this one persists");
  });
});
