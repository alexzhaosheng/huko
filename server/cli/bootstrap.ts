/**
 * server/cli/bootstrap.ts
 *
 * Shared CLI orchestrator setup.
 *
 * Builds:
 *   - SqlitePersistence (with migrations applied) — the daemon-shared store
 *   - TaskOrchestrator — wired with persistence + the formatter's emitter
 *
 * Returns a small handle so the command can teardown cleanly.
 *
 * Why share the same SQLite file as the daemon: lets `huko run` "see"
 * the providers/models the user already configured via the daemon, and
 * lets the daemon "see" sessions created by the CLI. Single source of
 * truth, no separate config to manage.
 *
 * Future: a `--memory` flag will swap in MemoryPersistence for fully
 * ephemeral runs (no DB writes, can't reuse daemon-side config).
 */

import { runMigrations } from "../db/migrate.js";
import { SqlitePersistence, type Persistence } from "../persistence/index.js";
import { TaskOrchestrator } from "../services/index.js";
import type { Formatter } from "./formatters/index.js";

export type CliBootstrap = {
  persistence: Persistence;
  orchestrator: TaskOrchestrator;
  shutdown(): void;
};

export function bootstrap(formatter: Formatter): CliBootstrap {
  runMigrations();
  const persistence = new SqlitePersistence();

  // Single formatter for the whole process — the CLI is one task at a time,
  // so we don't need per-room emitters. The factory ignores the room arg.
  const orchestrator = new TaskOrchestrator({
    persistence,
    emitterFactory: (_room: string) => formatter.emitter,
  });

  return {
    persistence,
    orchestrator,
    shutdown() {
      try {
        (persistence as unknown as { close?: () => void }).close?.();
      } catch {
        /* already closed */
      }
    },
  };
}
