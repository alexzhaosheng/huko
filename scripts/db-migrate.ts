/**
 * scripts/db-migrate.ts
 *
 * Apply any pending session-DB migrations to <cwd>/.huko/huko.db.
 * The backend migrates itself on construction; this script is the
 * "trigger that flow + report" wrapper for CI / first-time setup.
 *
 * The infra config (providers / models / default model) lives in
 * layered JSON files now — no migration needed; built-ins are present
 * by import. See `server/config/infra-config.ts`.
 *
 * Usage:
 *   npm run db:migrate
 */

import { SqliteSessionPersistence } from "../server/persistence/index.js";

let exitCode = 0;
try {
  const session = new SqliteSessionPersistence({ cwd: process.cwd() });
  console.log("session DB ready (<cwd>/.huko/huko.db)");
  session.close();
} catch (err) {
  console.error("migration failed:", err);
  exitCode = 1;
}

process.exit(exitCode);
