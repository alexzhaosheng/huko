/**
 * scripts/db-migrate.ts
 *
 * Apply any pending DB migrations.
 *
 * Usage:
 *   npm run db:migrate
 *
 * Each unapplied SQL file under server/db/migrations/ is run inside a
 * transaction; partial failures roll back. Already-applied migrations
 * are skipped (tracked in the `_migrations` table).
 */

import { runMigrations } from "../server/db/migrate.js";

const result = runMigrations();

if (result.applied.length > 0) {
  console.log(`Applied ${result.applied.length} migration(s):`);
  for (const v of result.applied) console.log(`  + ${v}`);
}
if (result.skipped.length > 0) {
  console.log(`Already applied: ${result.skipped.length} migration(s).`);
}
if (result.applied.length === 0 && result.skipped.length === 0) {
  console.log("No migrations found.");
}
