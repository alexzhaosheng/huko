/**
 * server/cli/bootstrap.ts
 *
 * Shared CLI orchestrator setup.
 *
 * Bootstrap deals in `InfraPersistence` + `SessionPersistence` abstractions.
 * It does NOT know about migrations, file paths, schema, or any other
 * backend implementation detail — those are each backend's own concern
 * (e.g. SqliteSessionPersistence runs its own migrations, auto-creates
 * `<cwd>/.huko/.gitignore`, etc., from its constructor).
 *
 * Two modes:
 *
 *   1. Default (persistent):
 *        - SqliteInfraPersistence at ~/.huko/infra.db
 *        - SqliteSessionPersistence at <cwd>/.huko/huko.db
 *
 *   2. Ephemeral (`{ ephemeral: true }`, surfaced as `--memory` on the CLI):
 *        - MemoryInfraPersistence (seeded from disk infra DB at startup,
 *          then disconnected — your saved providers/models are visible
 *          but no writes hit disk this run)
 *        - MemorySessionPersistence (sessions/tasks/entries vanish on exit)
 *
 * Orphan recovery: persistent mode runs `recoverOrphans()` once and
 * emits one `orphan_recovered` HukoEvent per healed task to
 * `formatter.emitter`. The text formatter renders these in yellow so
 * users notice that a previous crash got cleaned up.
 *
 * Concurrency: bootstrap itself does NOT acquire the per-cwd lock —
 * that's the caller's concern (the CLI command). `huko run` acquires
 * the lock BEFORE calling bootstrap so orphan recovery is also under
 * the lock.
 */

import {
  MemoryInfraPersistence,
  MemorySessionPersistence,
  SqliteInfraPersistence,
  SqliteSessionPersistence,
  type InfraPersistence,
  type SessionPersistence,
} from "../persistence/index.js";
import { TaskOrchestrator } from "../services/index.js";
import { loadConfig } from "../config/index.js";
import type { Formatter } from "./formatters/index.js";

export type BootstrapOptions = {
  /** When true, both DBs run in memory; infra is seeded from disk. */
  ephemeral?: boolean;
};

export type CliBootstrap = {
  infra: InfraPersistence;
  session: SessionPersistence;
  orchestrator: TaskOrchestrator;
  shutdown(): void;
};

export async function bootstrap(
  formatter: Formatter,
  options: BootstrapOptions = {},
): Promise<CliBootstrap> {
  // Load config FIRST — kernel modules read it via getConfig() at task
  // start. Layered: defaults < ~/.huko/config.json < <cwd>/.huko/config.json
  // < HUKO_CONFIG env. See docs/modules/config.md.
  loadConfig({ cwd: process.cwd() });

  const { infra, session } = options.ephemeral
    ? await buildEphemeralPersistences()
    : buildPersistentPersistences();

  // Single formatter for the whole process — the CLI is one task at a time,
  // so we don't need per-room emitters. The factory ignores the room arg.
  const orchestrator = new TaskOrchestrator({
    infra,
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
      // Emit per-task semantic events. The text formatter renders these
      // yellow; jsonl/json formatters serialise as-is.
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
      try {
        void infra.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ─── Persistent mode ─────────────────────────────────────────────────────────

function buildPersistentPersistences(): {
  infra: InfraPersistence;
  session: SessionPersistence;
} {
  const infra = new SqliteInfraPersistence();
  const session = new SqliteSessionPersistence({ cwd: process.cwd() });
  return { infra, session };
}

// ─── Ephemeral mode ──────────────────────────────────────────────────────────

/**
 * Build memory-backed persistences. Infra is seeded from the on-disk
 * infra DB so the user's saved providers/models still apply, then the
 * SQLite connection is closed. Session is a fresh in-memory store.
 */
async function buildEphemeralPersistences(): Promise<{
  infra: InfraPersistence;
  session: SessionPersistence;
}> {
  const memInfra = new MemoryInfraPersistence();
  const memSession = new MemorySessionPersistence();

  const diskInfra = new SqliteInfraPersistence();
  try {
    await seedInfraFromSource(memInfra, diskInfra);
  } finally {
    try {
      void diskInfra.close();
    } catch {
      /* already closed */
    }
  }

  return { infra: memInfra, session: memSession };
}

/**
 * Copy providers, models and default_model_id from `source` into `target`,
 * preserving foreign-key relationships. Ids may be reassigned by the
 * target — local maps keep model.providerId and the default_model_id
 * config value pointing to the right new rows.
 */
async function seedInfraFromSource(
  target: InfraPersistence,
  source: InfraPersistence,
): Promise<void> {
  const sourceProviders = await source.providers.list();
  const providerIdMap = new Map<number, number>();
  for (const p of sourceProviders) {
    const newId = await target.providers.create({
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyRef: p.apiKeyRef,
      defaultHeaders: p.defaultHeaders ?? null,
    });
    providerIdMap.set(p.id, newId);
  }

  const sourceModels = await source.models.list();
  const modelIdMap = new Map<number, number>();
  for (const m of sourceModels) {
    const newProviderId = providerIdMap.get(m.providerId);
    if (newProviderId === undefined) continue;
    const newId = await target.models.create({
      providerId: newProviderId,
      modelId: m.modelId,
      displayName: m.displayName,
      defaultThinkLevel: m.defaultThinkLevel,
      defaultToolCallMode: m.defaultToolCallMode,
    });
    modelIdMap.set(m.id, newId);
  }

  const oldDefault = await source.config.getDefaultModelId();
  if (oldDefault !== null) {
    const newDefault = modelIdMap.get(oldDefault);
    if (newDefault !== undefined) {
      await target.config.setDefaultModelId(newDefault);
    }
  }
}
