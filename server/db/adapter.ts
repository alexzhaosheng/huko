/**
 * server/db/adapter.ts
 *
 * Wires the session DB to the engine's dependency-injection seams.
 *
 * The engine (SessionContext) depends on three pure-function interfaces:
 *   - PersistFn  — append a new task_context row, return its id
 *   - UpdateFn   — patch an existing row's content / metadata
 *   - Emitter    — push WebSocket events (NOT in this file — see gateway.ts)
 *
 * This module provides factories that bind those interfaces to a Drizzle
 * handle bound to the SESSION schema. The orchestrator wires them up at
 * task spinup.
 *
 * Also exposes:
 *   - loadSessionLLMContext(sessionId, type) — replay history → LLMMessage[]
 *     for resuming a session (and for the orchestrator's first lookup
 *     when a chat is reopened)
 *   - dbEntryToLLMMessage(row) — the projection function. Single decision
 *     point for "what does a DB row look like as an LLMMessage".
 */

import { eq, and, asc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { LLMMessage, ToolCall } from "../core/llm/types.js";
import type { PersistFn, UpdateFn } from "../engine/SessionContext.js";
import type { EntryKind, SessionType } from "../../shared/types.js";
import { isLLMVisible } from "../../shared/types.js";
import * as sessionSchema from "./schema/session.js";

const { taskContext } = sessionSchema;

/** Drizzle handle bound to the session schema. */
export type SessionDb = BetterSQLite3Database<typeof sessionSchema>;

// ─── PersistFn / UpdateFn factories ──────────────────────────────────────────

export function makePersistEntry(db: SessionDb): PersistFn {
  return async (entry) => {
    const row = await db
      .insert(taskContext)
      .values({
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        sessionType: entry.sessionType,
        kind: entry.kind,
        role: entry.role,
        content: entry.content,
        toolCallId: entry.toolCallId ?? null,
        thinking: entry.thinking ?? null,
        metadata: entry.metadata ?? null,
      })
      .returning({ id: taskContext.id })
      .get();
    return row.id;
  };
}

export function makeUpdateEntry(db: SessionDb): UpdateFn {
  return async (entryId, patch) => {
    if (patch.content === undefined && patch.metadata === undefined) return;

    // metadata-merge requires read+modify+write; do it inside a sync
    // transaction so concurrent writers can't race the merge.
    db.transaction((tx) => {
      const set: Record<string, unknown> = {};

      if (patch.content !== undefined) set["content"] = patch.content;

      if (patch.metadata !== undefined) {
        if (patch.mergeMetadata) {
          const existing = tx
            .select({ metadata: taskContext.metadata })
            .from(taskContext)
            .where(eq(taskContext.id, entryId))
            .get();
          const existingMeta =
            (existing?.metadata as Record<string, unknown> | null | undefined) ?? {};
          set["metadata"] = { ...existingMeta, ...patch.metadata };
        } else {
          set["metadata"] = patch.metadata;
        }
      }

      tx.update(taskContext).set(set).where(eq(taskContext.id, entryId)).run();
    });
  };
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Replay a session's persisted history into an `LLMMessage[]` ready to
 * hand to a SessionContext as `initialContext`. Filters out:
 *   - non-LLM-visible entries (StatusNotice)
 *   - entries marked elided by a previous `compaction_done` reminder
 *
 * Order is by row id, which is monotonic and matches insertion order.
 *
 * Performance note: one SELECT, one pass. Earlier shape used a second
 * query in `SqliteSessionPersistence.loadLLMContext` to compute the
 * elided set; folding it in here halves the I/O on every session
 * resume against a long conversation.
 */
export async function loadSessionLLMContext(
  db: SessionDb,
  sessionId: number,
  sessionType: SessionType,
): Promise<LLMMessage[]> {
  const rows = await db
    .select()
    .from(taskContext)
    .where(
      and(
        eq(taskContext.sessionId, sessionId),
        eq(taskContext.sessionType, sessionType),
      ),
    )
    .orderBy(asc(taskContext.id))
    .all();

  const elided = collectElidedEntryIdsFromRows(rows);
  const messages: LLMMessage[] = [];
  for (const row of rows) {
    if (elided.has(row.id)) continue;
    const m = dbEntryToLLMMessage(row);
    if (m) messages.push(m);
  }
  return messages;
}

// ─── Elision (compaction-done bookkeeping) ───────────────────────────────────

/**
 * Walk SystemReminder entries with `reminderReason: "compaction_done"`,
 * gather their `metadata.elidedEntryIds` arrays. Returns the union —
 * IDs to drop on context replay.
 *
 * Generic over row shape so both the SQLite backend (raw Drizzle rows)
 * and the Memory backend (`EntryRow`s) can share this single decision
 * point. The two backends previously both implemented this logic; the
 * Sqlite call additionally re-queried task_context to feed it. Both
 * issues collapse to "share one function over rows the caller already
 * has".
 */
export function collectElidedEntryIdsFromRows(
  rows: ReadonlyArray<{
    id: number;
    kind: string;
    metadata: Record<string, unknown> | null;
  }>,
): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.kind !== "system_reminder") continue;
    const meta = r.metadata;
    if (!meta || meta["reminderReason"] !== "compaction_done") continue;
    const ids = meta["elidedEntryIds"];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "number") out.add(id);
      }
    }
  }
  return out;
}

// ─── Projection: DB row → LLMMessage ─────────────────────────────────────────

/**
 * The single decision point for "how does a persisted entry look as an
 * LLMMessage in the in-memory context array".
 *
 *   - Returns null for non-LLM-visible entries (StatusNotice).
 *   - Pulls `metadata.toolCalls` back into the structured `toolCalls`
 *     field — symmetric with how `SessionContext.append()` writes it.
 *   - Carries `_entryId` and `_entryKind` for compaction (which messages
 *     to evict, how to summarise them) and orphan-recovery routines.
 */
export function dbEntryToLLMMessage(
  row: typeof taskContext.$inferSelect,
): LLMMessage | null {
  if (!isLLMVisible(row.kind as EntryKind)) return null;

  const meta = row.metadata as Record<string, unknown> | null;
  const toolCalls = meta?.["toolCalls"] as ToolCall[] | undefined;

  return {
    role: row.role,
    content: row.content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    ...(row.thinking ? { thinking: row.thinking } : {}),
    _entryId: row.id,
    _entryKind: row.kind as EntryKind,
  };
}
