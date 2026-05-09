/**
 * tests/sqlite-infra.test.ts
 *
 * Runs the shared `runInfraSuite` against `SqliteInfraPersistence`.
 *
 * Each test gets a fresh tmpdir + dbPath so the suite never touches the
 * user's real `~/.huko/infra.db`. Schema migrations run on construction
 * (see SqliteInfraPersistence ctor); no manual setup required.
 *
 * SQLite-only behaviour goes here as additional `describe` blocks; the
 * shared suite covers the cross-backend behavioural contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteInfraPersistence } from "../server/persistence/sqlite-infra.js";
import { runInfraSuite } from "./persistence-suite.js";

runInfraSuite("sqlite", () => {
  const tmp = mkdtempSync(join(tmpdir(), "huko-infra-test-"));
  const instance = new SqliteInfraPersistence({ dbPath: join(tmp, "infra.db") });
  return {
    instance,
    teardown: () => {
      instance.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
});
