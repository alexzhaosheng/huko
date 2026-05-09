/**
 * server/db/migrate.ts
 *
 * Migration runner — generic over (sqlite handle, migrations dir).
 *
 * Convention:
 *   - Migration files named `NNNN_name.sql`, applied in lexicographic order
 *   - Each file wrapped in a transaction; partial failures roll back
 *   - Applied versions tracked in this DB's `_migrations` table
 *
 * The runner is per-handle: each Sqlite persistence backend (infra,
 * session) calls it with its own handle and its own migrations
 * subdirectory. The `_migrations` book-keeping table is created lazily
 * inside the target DB.
 *
 * Schema drift between Drizzle's `schema/{infra,session}.ts` and the
 * SQL files is the author's responsibility — when you touch a column,
 * update both.
 */

import path from "node:path";
import fs from "node:fs";
import type { Database as BetterSqlite3Database } from "better-sqlite3";

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Apply every `*.sql` in `migrationsDir` (sorted) that hasn't been
 * applied to this handle yet. Idempotent.
 */
export function runMigrations(
  sqlite: BetterSqlite3Database,
  migrationsDir: string,
): MigrationResult {
  ensureMigrationsTable(sqlite);
  const applied = readAppliedSet(sqlite);

  if (!fs.existsSync(migrationsDir)) {
    return { applied: [], skipped: [] };
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic — relies on zero-padded NNNN_ prefix

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      skipped.push(version);
      continue;
    }

    const ddl = fs.readFileSync(path.join(migrationsDir, file), "utf8");

    sqlite.transaction(() => {
      sqlite.exec(ddl);
      sqlite
        .prepare("INSERT INTO _migrations (version) VALUES (?)")
        .run(version);
    })();

    newlyApplied.push(version);
  }

  return { applied: newlyApplied, skipped };
}

// ─── Internals ───────────────────────────────────────────────────────────────

function ensureMigrationsTable(sqlite: BetterSqlite3Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}

function readAppliedSet(sqlite: BetterSqlite3Database): Set<string> {
  const rows = sqlite
    .prepare("SELECT version FROM _migrations")
    .all() as Array<{ version: string }>;
  return new Set(rows.map((r) => r.version));
}
