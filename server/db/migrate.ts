/**
 * server/db/migrate.ts
 *
 * Migration runner.
 *
 * Convention:
 *   - Migration files live in `./migrations/` named `NNNN_name.sql`
 *   - Files are applied in lexicographic order (zero-pad the number)
 *   - Each file is wrapped in a transaction; partial failures roll back
 *   - Applied versions are tracked in the `_migrations` table
 *
 * We deliberately do NOT use drizzle-kit. SQLite's limited ALTER TABLE
 * means many schema changes need the new-table-copy-data dance, which
 * is easier to write and review as hand-authored SQL.
 *
 * Schema drift between `schema.ts` and the SQL files is the author's
 * responsibility — when you touch a column, update both.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sqlite } from "./client.js";

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export function runMigrations(): MigrationResult {
  ensureMigrationsTable();
  const applied = readAppliedSet();

  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    return { applied: [], skipped: [] };
  }

  const files = fs
    .readdirSync(dir)
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

    const ddl = fs.readFileSync(path.join(dir, file), "utf8");

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

function ensureMigrationsTable(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}

function readAppliedSet(): Set<string> {
  const rows = sqlite
    .prepare("SELECT version FROM _migrations")
    .all() as Array<{ version: string }>;
  return new Set(rows.map((r) => r.version));
}

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}
