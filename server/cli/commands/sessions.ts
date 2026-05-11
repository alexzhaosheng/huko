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
 * "Empty cwd" UX
 * ──────────────
 * Read-only verbs (`list`, `delete`, `switch`) check for
 * `<cwd>/.huko/huko.db` BEFORE constructing the persistence. If the
 * file isn't there, the user hasn't initialised any state in this
 * directory — we say so cleanly and return without creating .huko/ as
 * a side effect. SqliteSessionPersistence's constructor would
 * otherwise mkdir it, drop a .gitignore, and open a fresh empty DB
 * just to satisfy a peek — surprising and wrong.
 *
 * For `delete` and `switch`, "no DB here" is presented the same as
 * "session id not found" (exit 4). Same user mental model: that id
 * doesn't exist.
 *
 * Exit codes:
 *   0  — success (incl. empty dir for `list` / `current`)
 *   1  — internal error
 *   4  — target not found (incl. delete/switch in dir with no DB)
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { SqliteSessionPersistence, type SessionPersistence } from "../../persistence/index.js";
import type { ChatSessionRow } from "../../persistence/types.js";
import {
  getActiveSessionId,
  setActiveSessionId,
} from "../state.js";
import { bold, cyan, dim, padVisible } from "../colors.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type SessionsListArgs = {
  format: OutputFormat;
};

export type SessionsDeleteArgs = {
  id: number;
};

// ─── list ────────────────────────────────────────────────────────────────────

export async function sessionsListCommand(args: SessionsListArgs): Promise<number> {
  const cwd = process.cwd();

  // No DB on disk → no sessions, full stop. Don't materialise .huko/
  // as a side effect of a read.
  if (!hasSessionDb(cwd)) {
    return printSessions([], args.format);
  }

  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence();
    const rows = await persistence.sessions.list();
    return printSessions(rows, args.format);
  } catch (err) {
    if (isMissingTableError(err)) {
      // DB file exists but the schema doesn't (migrations didn't run,
      // or the file is from an older / corrupted layout). Surface as
      // "no sessions" — same as a fresh dir. The user's recovery is
      // to remove .huko/ and start over; we don't pre-empt that.
      return printSessions([], args.format);
    }
    process.stderr.write(`huko: sessions list failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── delete ──────────────────────────────────────────────────────────────────

export async function sessionsDeleteCommand(args: SessionsDeleteArgs): Promise<number> {
  const cwd = process.cwd();

  if (!hasSessionDb(cwd)) {
    process.stderr.write(
      `huko: no sessions in this directory yet (session ${args.id} not found)\n`,
    );
    return 4;
  }

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
    // next `huko` creates a fresh one.
    if (getActiveSessionId(cwd) === args.id) {
      setActiveSessionId(cwd, null);
    }
    return 0;
  } catch (err) {
    if (isMissingTableError(err)) {
      process.stderr.write(
        `huko: no sessions in this directory yet (session ${args.id} not found)\n`,
      );
      return 4;
    }
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

  // No state.json or no active id → no current session. Already a
  // clean empty-dir path; no DB construction needed.
  if (id === null) {
    process.stdout.write("(none)\n");
    return 0;
  }

  // Active pointer exists but DB went missing — recoverable, surface
  // as a stale-pointer notice (same as before).
  if (!hasSessionDb(cwd)) {
    process.stdout.write(
      `${id} (no longer in DB; next run will create a fresh session)\n`,
    );
    return 0;
  }

  let persistence: SessionPersistence | null = null;
  try {
    persistence = new SqliteSessionPersistence({ cwd });
    const row = await persistence.sessions.get(id);
    if (!row) {
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
    if (isMissingTableError(err)) {
      process.stdout.write(
        `${id} (no longer in DB; next run will create a fresh session)\n`,
      );
      return 0;
    }
    process.stderr.write(`huko: sessions current failed: ${describe(err)}\n`);
    return 1;
  } finally {
    closeQuietly(persistence);
  }
}

// ─── switch ──────────────────────────────────────────────────────────────────

export async function sessionsSwitchCommand(args: { id: number }): Promise<number> {
  const cwd = process.cwd();

  if (!hasSessionDb(cwd)) {
    process.stderr.write(
      `huko: no sessions in this directory yet (session ${args.id} not found)\n`,
    );
    return 4;
  }

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
    if (isMissingTableError(err)) {
      process.stderr.write(
        `huko: no sessions in this directory yet (session ${args.id} not found)\n`,
      );
      return 4;
    }
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
  // `new` is a write — it's the canonical "I want huko state in this
  // dir" command, so it constructs the persistence unconditionally.
  // (Migrations run inside the constructor; if those break, that's a
  // setup bug and a clean error message would be nice — but it isn't
  // the empty-dir UX problem.)
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

/**
 * True if `<cwd>/.huko/huko.db` exists. Cheap stat call — used to
 * short-circuit read commands before any DB construction.
 */
function hasSessionDb(cwd: string): boolean {
  return existsSync(path.join(cwd, ".huko", "huko.db"));
}

/**
 * Recognise SQLite's "no such table: X" error so we can re-render it
 * as a clean empty-state message rather than leaking SQL noise.
 */
function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /no such table/i.test(err.message);
}

function printSessions(rows: ChatSessionRow[], format: OutputFormat): number {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  switch (format) {
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
}

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
    process.stdout.write(dim("(no chat sessions)") + "\n");
    return;
  }

  const headerCells = ["ID", "TITLE", "CREATED", "UPDATED"];
  const raw: string[][] = [];
  const styled: string[][] = [];
  for (const r of rows) {
    const idStr = String(r.id);
    const title = truncate(r.title || "(untitled)", 60);
    const created = formatTime(r.createdAt);
    const updated = formatTime(r.updatedAt);
    raw.push([idStr, title, created, updated]);
    styled.push([cyan(idStr), title, dim(created), dim(updated)]);
  }

  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...raw.map((row) => row[i]!.length)),
  );

  const sep = "  ";
  const lines: string[] = [];
  lines.push(headerCells.map((h, i) => bold(padVisible(h, widths[i]!))).join(sep));
  lines.push(dim(widths.map((w) => "─".repeat(w)).join(sep)));
  for (const row of styled) {
    lines.push(row.map((cell, i) => padVisible(cell, widths[i]!)).join(sep));
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
