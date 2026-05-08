/**
 * server/cli/bootstrap.ts
 *
 * Shared CLI orchestrator setup.
 *
 * Bootstrap deals in Persistence abstractions. It does NOT know about
 * migrations, file paths, schema, or any other backend implementation
 * detail — those are each backend's own concern (e.g. SqlitePersistence
 * runs its own migrations from its constructor).
 *
 * Two modes:
 *
 *   1. Default (persistent):
 *        - SqlitePersistence
 *        - sessions / tasks / entries land in huko.db
 *
 *   2. Ephemeral (`{ ephemeral: true }`, surfaced as `--memory` on the CLI):
 *        - MemoryPersistence
 *        - sessions / tasks / entries are in-memory only — vanish on exit
 *        - providers / models / default_model_id are SEEDED from a
 *          short-lived SqlitePersistence at startup so the user's saved
 *          config still applies; that connection is then closed
 */

import {
  MemoryPersistence,
  SqlitePersistence,
  type Persistence,
} from "../persistence/index.js";
import { TaskOrchestrator } from "../services/index.js";
import { loadConfig } from "../config/index.js";
import type { Formatter } from "./formatters/index.js";

export type BootstrapOptions = {
  /** When true, use MemoryPersistence seeded from SQLite for config. */
  ephemeral?: boolean;
};

export type CliBootstrap = {
  persistence: Persistence;
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

  const persistence = options.ephemeral
    ? await buildEphemeralPersistence()
    : new SqlitePersistence();

  // Single formatter for the whole process — the CLI is one task at a time,
  // so we don't need per-room emitters. The factory ignores the room arg.
  const orchestrator = new TaskOrchestrator({
    persistence,
    emitterFactory: (_room: string) => formatter.emitter,
  });

  // Heal any orphan tasks left over from a crashed previous process —
  // mark them failed, inject synthetic tool_results to keep history valid
  // for any future continue-conversation. Skipped in ephemeral mode (the
  // memory backend has nothing to find).
  if (!options.ephemeral) {
    const report = await orchestrator.recoverOrphans();
    if (report.healed > 0) {
      process.stderr.write(
        `huko: recovered ${report.healed} orphan task(s) ` +
          `(${report.byKind.danglingTools} mid-tool, ` +
          `${report.byKind.waitingForReply} ask, ` +
          `${report.byKind.waitingForApproval} approval)\n`,
      );
    }
  }

  return {
    persistence,
    orchestrator,
    shutdown() {
      try {
        void persistence.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ─── Ephemeral mode ──────────────────────────────────────────────────────────

/**
 * Build a MemoryPersistence pre-seeded with providers / models / default
 * model from the on-disk SQLite. The SQLite connection is opened just
 * long enough to copy these rows, then closed — no writes hit the disk.
 */
async function buildEphemeralPersistence(): Promise<Persistence> {
  const sqlite = new SqlitePersistence();
  const memory = new MemoryPersistence();
  try {
    await seedFromSource(memory, sqlite);
  } finally {
    try {
      void sqlite.close();
    } catch {
      /* already closed */
    }
  }
  return memory;
}

/**
 * Copy providers, models and default_model_id from `source` into
 * `target`, preserving the foreign-key relationships.
 *
 * Ids may be reassigned by the target — `seedFromSource` keeps id maps
 * locally so model.providerId and the default_model_id config value
 * point to the right new rows after the copy.
 */
async function seedFromSource(target: Persistence, source: Persistence): Promise<void> {
  const sourceProviders = await source.providers.list();
  const providerIdMap = new Map<number, number>();
  for (const p of sourceProviders) {
    const newId = await target.providers.create({
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
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
