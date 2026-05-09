/**
 * server/cli/commands/sessions.ts
 *
 * `huko sessions <verb>` — chat-session inspector / manager.
 *
 * Verbs:
 *   - `list`              show all chat sessions in the local DB
 *   - `delete <id>`       cascade-delete a session (and its tasks + entries)
 *   - `current`           print the active session id (or `(none)`)
 *   - `switch <id>`       set <id> as active session for this cwd
 *   - `new [--title=...]` create a new (empty) session and set it active
 *
 * Each command returns `Promise<number>` (exit code). The single
 * `process.exit()` site lives in `cli/index.ts` so these commands are
 * usable from tests / future REPL / tRPC handlers without killing the
 * host process.
 *
 * No SessionContext / Orchestrator needed — these only read/write the
 * SessionPersistence interface plus `<cwd>/.huko/state.json` for the
 * active pointer.
 *
 * Exit codes:
 *   0  — success
 *   1  — internal error
 *   4  — target not found (e.g. delete <id> for a nonexistent session)
 */

import { SqliteSessionPersistence, type SessionPersistence } from "../../persistence/index.js";
import type { ChatSessionRow } from "../../persistence/types.js";
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../state.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type SessionsListArgs = {
  format: OutputFormat;
};

export type SessionsDeleteArgs = {
  id: number;
};

// ─── list ────────────────────────────────────────────────────────────────────

export async function sessionsListCommand(args: SessionsListArgs): Promise<number> {
  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence();
    const rows = await persistence.sessions.list();

    const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);

    switch (args.format) {
      case "json":
        process.stdout.write(
          JSON.stringify(sorted.map(serialiseSession), null, 2) + "\n",
        );
        break;

      case "jsonl":
        for (const r of sorted) {
          process.stdout.write(JSON.stringify(serialiseSession(r)) + "\n");
        }
        break;

      case "text":
      default:
        printSessionsTable(sorted);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: sessions list failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── delete ──────────────────────────────────────────────────────────────────

export async function sessionsDeleteCommand(args: SessionsDeleteArgs): Promise<number> {
  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence();

    const existing = await persistence.sessions.get(args.id);
    if (!existing) {
      process.stderr.write(`huko: session ${args.id} not found\n`);
      return 4;
    }

    await persistence.sessions.delete(args.id);
    process.stderr.write(
      `huko: deleted session ${args.id} ("${truncate(existing.title, 60)}")\n`,
    );

    // If we just deleted the active session, clear the pointer so the
    // next `huko run` creates a fresh one.
    const cwd = process.cwd();
    if (getActiveSessionId(cwd) === args.id) {
      setActiveSessionId(cwd, null);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: sessions delete failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── current ─────────────────────────────────────────────────────────────────

export async function sessionsCurrentCommand(): Promise<number> {
  const cwd = process.cwd();
  const id = getActiveSessionId(cwd);

  let persistence: SessionPersistence | null = null;
  try {
    if (id === null) {
      process.stdout.write("(none)\n");
      return 0;
    }
    persistence = new SqliteSessionPersistence({ cwd });
    const row = await persistence.sessions.get(id);
    if (!row) {
      // Stale pointer — surfaces a recoverable state to the user.
      process.stdout.write(
        `${id} (no longer in DB; next run will create a fresh session)\n`,
      );
    } else {
      process.stdout.write(
        `${row.id}  ${row.title || "(untitled)"}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: sessions current failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── switch ──────────────────────────────────────────────────────────────────

export async function sessionsSwitchCommand(args: { id: number }): Promise<number> {
  const cwd = process.cwd();
  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence({ cwd });
    const row = await persistence.sessions.get(args.id);
    if (!row) {
      process.stderr.write(`huko: session ${args.id} not found\n`);
      return 4;
    }
    setActiveSessionId(cwd, args.id);
    process.stderr.write(
      `huko: active session -> ${args.id} ("${truncate(row.title, 60)}")\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: sessions switch failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── new ─────────────────────────────────────────────────────────────────────

export async function sessionsNewCommand(args: { title?: string }): Promise<number> {
  const cwd = process.cwd();
  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence({ cwd });
    const id = await persistence.sessions.create({
      ...(args.title !== undefined ? { title: args.title } : {}),
    });
    setActiveSessionId(cwd, id);
    process.stderr.write(
      `huko: created session ${id}${args.title ? ` ("${truncate(args.title, 60)}")` : ""} and set it active\n`,
    );
    process.stdout.write(String(id) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`huko: sessions new failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function closeQuietly(p: SessionPersistence | null): void {
  if (!p) return;
  try {
    void p.close();
  } catch {
    /* already closed */
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serialiseSession(row: ChatSessionRow): {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    title: row.title,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function printSessionsTable(rows: ChatSessionRow[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no chat sessions)\n");
    return;
  }

  const header = ["ID", "TITLE", "CREATED", "UPDATED"];
  const data = rows.map((r) => [
    String(r.id),
    truncate(r.title || "(untitled)", 60),
    formatTime(r.createdAt),
    formatTime(r.updatedAt),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );

  const sep = "  ";
  const lines: string[] = [];
  lines.push(header.map((h, i) => pad(h, widths[i]!)).join(sep));
  lines.push(widths.map((w) => "─".repeat(w)).join(sep));
  for (const row of data) {
    lines.push(row.map((cell, i) => pad(cell, widths[i]!)).join(sep));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes())
  );
}
