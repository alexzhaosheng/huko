/**
 * server/db/migrate.ts
 *
 * Migration runner — generic over (sqlite handle, migrations array).
 *
 * Each backend (infra / session) calls this with its own handle and
 * its own migrations from `./migrations.ts`. Migrations are passed in
 * as data, not as a directory path; this used to read `.sql` files
 * from disk relative to `import.meta.url`, which broke once the code
 * was bundled into dist/cli.js (the .sql files weren't shipped, and
 * the relative path differed). See migrations.ts for the rationale.
 *
 * Convention:
 *   - Each migration is `{version, sql}`. Versions follow the
 *     `NNNN_name` pattern, applied in array order.
 *   - Each migration runs in its own transaction; partial failures
 *     roll back, leaving `_migrations` untouched for that version.
 *   - Applied versions are tracked in this DB's `_migrations` table.
 *   - Idempotent: re-running is a no-op once everything is applied.
 *
 * Schema drift between Drizzle's `schema/{infra,session}.ts` and the
 * inline SQL in `migrations.ts` is the author's responsibility — when
 * you touch a column, update both.
 */

import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { Migration } from "./migrations.js";

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Apply every migration in `migrations` (in order) that hasn't been
 * applied to this handle yet. Idempotent.
 */
export function runMigrations(
  sqlite: BetterSqlite3Database,
  migrations: Migration[],
): MigrationResult {
  ensureMigrationsTable(sqlite);
  const applied = readAppliedSet(sqlite);

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const m of migrations) {
    if (applied.has(m.version)) {
      skipped.push(m.version);
      continue;
    }

    sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .prepare("INSERT INTO _migrations (version) VALUES (?)")
        .run(m.version);
    })();

    newlyApplied.push(m.version);
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
