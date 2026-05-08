/**
 * server/cli/commands/sessions.ts
 *
 * `huko sessions <verb>` — chat-session inspector / manager.
 *
 * Verbs:
 *   - `list`              show all chat sessions in the local DB
 *   - `delete <id>`       cascade-delete a session (and its tasks + entries)
 *
 * Coming later:
 *   - `get <id>`          show a single session's metadata + entry count
 *   - `show <id>`         render a session's full conversation history
 *
 * No SessionContext / Orchestrator needed — this only reads/writes the
 * Persistence tier 2 surface. SqlitePersistence's constructor handles
 * its own schema migrations.
 *
 * Exit codes:
 *   0  — success
 *   1  — internal error
 *   3  — usage error
 *   4  — target not found (e.g. delete <id> for a nonexistent session)
 */

import { SqlitePersistence, type Persistence } from "../../persistence/index.js";
import type { ChatSessionRow } from "../../persistence/types.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type SessionsListArgs = {
  format: OutputFormat;
};

export type SessionsDeleteArgs = {
  id: number;
};

// ─── list ────────────────────────────────────────────────────────────────────

export async function sessionsListCommand(args: SessionsListArgs): Promise<void> {
  let persistence: Persistence | null = null;
  let exitCode = 0;
  try {
    persistence = new SqlitePersistence();
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: sessions list failed: ${msg}\n`);
    exitCode = 1;
  } finally {
    closeQuietly(persistence);
  }

  process.exit(exitCode);
}

// ─── delete ──────────────────────────────────────────────────────────────────

export async function sessionsDeleteCommand(args: SessionsDeleteArgs): Promise<void> {
  let persistence: Persistence | null = null;
  let exitCode = 0;
  try {
    persistence = new SqlitePersistence();

    const existing = await persistence.sessions.get(args.id);
    if (!existing) {
      process.stderr.write(`huko: session ${args.id} not found\n`);
      exitCode = 4;
      return;
    }

    await persistence.sessions.delete(args.id);
    process.stderr.write(
      `huko: deleted session ${args.id} ("${truncate(existing.title, 60)}")\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: sessions delete failed: ${msg}\n`);
    exitCode = 1;
  } finally {
    closeQuietly(persistence);
  }

  process.exit(exitCode);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function closeQuietly(p: Persistence | null): void {
  if (!p) return;
  try {
    void p.close();
  } catch {
    /* already closed */
  }
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
