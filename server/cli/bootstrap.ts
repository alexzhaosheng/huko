/**
 * server/cli/bootstrap.ts
 *
 * Shared CLI orchestrator setup.
 *
 * Bootstrap deals in:
 *   - `InfraConfig` — providers, models, default model. Loaded from
 *     layered JSON files via `loadInfraConfig({ cwd })`. Built-ins +
 *     `~/.huko/providers.json` (global) + `<cwd>/.huko/providers.json`
 *     (project), merged. NO database — providers/models are config.
 *   - `SessionPersistence` — chat sessions, tasks, entries. Per-project
 *     SQLite at `<cwd>/.huko/huko.db`, OR Memory in `--memory` mode.
 *   - `TaskOrchestrator` — built around the SessionPersistence; receives
 *     a pre-resolved ResolvedModel per call from the caller (run.ts).
 *
 * Two modes:
 *
 *   1. Default (persistent):
 *        - SqliteSessionPersistence at <cwd>/.huko/huko.db
 *
 *   2. Ephemeral (`{ ephemeral: true }`, surfaced as `--memory` on the CLI):
 *        - MemorySessionPersistence (sessions/tasks/entries vanish on exit)
 *
 * Note: `--memory` only swaps the SESSION layer. InfraConfig is read
 * from the same JSON files in both modes — the user's saved
 * providers/models always apply. (Old design rebuilt a Memory infra
 * from a Sqlite seed; that hack is gone with the JSON layering.)
 *
 * Orphan recovery: persistent mode runs `recoverOrphans()` once and
 * emits one `orphan_recovered` HukoEvent per healed task to
 * `formatter.emitter`. The text formatter renders these in yellow so
 * users notice that a previous crash got cleaned up.
 *
 * Concurrency: bootstrap itself does NOT acquire the per-cwd lock —
 * that's the caller's concern (the CLI command). `huko` acquires
 * the lock BEFORE calling bootstrap so orphan recovery is also under
 * the lock.
 */

import {
  MemorySessionPersistence,
  SqliteSessionPersistence,
  type SessionPersistence,
} from "../persistence/index.js";
import { TaskOrchestrator } from "../services/index.js";
import { loadConfig, loadInfraConfig, type InfraConfig } from "../config/index.js";
import type { Formatter } from "./formatters/index.js";

export type BootstrapOptions = {
  /** When true, the session DB is in-memory; .huko/state.json untouched. */
  ephemeral?: boolean;
};

export type CliBootstrap = {
  infra: InfraConfig;
  session: SessionPersistence;
  orchestrator: TaskOrchestrator;
  shutdown(): void;
};

export async function bootstrap(
  formatter: Formatter,
  options: BootstrapOptions = {},
): Promise<CliBootstrap> {
  // Load runtime config eagerly. Not strictly required — getConfig()
  // self-loads on first access — but bootstrap is the canonical entry
  // and this lets us surface any malformed-config warnings up front
  // rather than at the first kernel read.
  loadConfig({ cwd: process.cwd() });

  // Infra config is sync, file-based. Same in both persistent and
  // ephemeral modes — providers / models are user configuration, not
  // session state.
  const infra = loadInfraConfig({ cwd: process.cwd() });

  const session: SessionPersistence = options.ephemeral
    ? new MemorySessionPersistence()
    : new SqliteSessionPersistence({ cwd: process.cwd() });

  // Single formatter for the whole process — the CLI is one task at a time,
  // so we don't need per-room emitters. The factory ignores the room arg.
  const orchestrator = new TaskOrchestrator({
    session,
    emitterFactory: (_room: string) => formatter.emitter,
  });

  // Heal any orphan tasks left over from a crashed previous process —
  // mark them failed, inject synthetic tool_results to keep history valid
  // for any future continue-conversation. Skipped in ephemeral mode (the
  // memory backend has nothing to find).
  if (!options.ephemeral) {
    const report = await orchestrator.recoverOrphans();
    if (report.healed > 0) {
      const now = Date.now();
      for (const rec of report.records) {
        formatter.emitter.emit({
          type: "orphan_recovered",
          taskId: rec.taskId,
          sessionId: rec.sessionId,
          sessionType: rec.sessionType,
          ts: now,
          reason: rec.reason,
          danglingToolCount: rec.danglingToolCount,
        });
      }
    }
  }

  return {
    infra,
    session,
    orchestrator,
    shutdown() {
      try {
        void session.close();
      } catch {
        /* already closed */
      }
    },
  };
}
