/**
 * scripts/db-migrate.ts
 *
 * Apply any pending DB migrations to BOTH the user-global infra DB and
 * the per-cwd session DB. Both backends migrate themselves on construction,
 * so this script is mostly a "trigger that flow + report" wrapper for CI.
 *
 * Usage:
 *   npm run db:migrate
 */

import {
  SqliteInfraPersistence,
  SqliteSessionPersistence,
} from "../server/persistence/index.js";

let exitCode = 0;
try {
  const infra = new SqliteInfraPersistence();
  console.log("infra DB ready (~/.huko/infra.db)");
  infra.close();

  const session = new SqliteSessionPersistence({ cwd: process.cwd() });
  console.log("session DB ready (<cwd>/.huko/huko.db)");
  session.close();
} catch (err) {
  console.error("migration failed:", err);
  exitCode = 1;
}

process.exit(exitCode);
