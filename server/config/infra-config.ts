/**
 * server/config/infra-config.ts
 *
 * Loader, merger, and writers for the layered infra config (providers,
 * models, default model). Replaces the old SQLite-backed
 * InfraPersistence — providers/models are declarative configuration,
 * not state, so they live in JSON files alongside `keys.json` and
 * `config.json`.
 *
 * Layering (low → high precedence):
 *   1. Built-in (server/config/builtin-providers.ts)
 *   2. ~/.huko/providers.json    (global, edit by user)
 *   3. <cwd>/.huko/providers.json (project, can be in git)
 *
 * Public API:
 *   - loadInfraConfig({ cwd? })  →  fully-merged InfraConfig (sync)
 *   - findModel(infra, providerName, modelId) → ResolvedModel | null
 *   - findProvider(infra, name) → ResolvedProvider | null
 *
 *   Writers (used by the CLI provider/model commands):
 *   - readGlobalConfigFile() / writeGlobalConfigFile(file)
 *   - readProjectConfigFile(cwd) / writeProjectConfigFile(cwd, file)
 *
 * Notes:
 *   - All file ops are synchronous (small files, infrequent reads).
 *   - Missing files are equivalent to `{}` — no error.
 *   - Malformed JSON throws with the file path included so the user
 *     can find which file is broken.
 *   - We don't auto-create the JSON files. `huko provider add` does
 *     that on demand.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDERS,
} from "./builtin-providers.js";
import type {
  ConfigSource,
  InfraConfig,
  InfraConfigFile,
  ModelConfig,
  ProviderConfig,
  ProviderModelRef,
  ResolvedModel,
  ResolvedProvider,
} from "./infra-config-types.js";

export type LoadInfraConfigOptions = {
  /** Project root for the project layer. Defaults to process.cwd(). */
  cwd?: string;
};

// ─── Load + merge ───────────────────────────────────────────────────────────

export function loadInfraConfig(opts: LoadInfraConfigOptions = {}): InfraConfig {
  const cwd = opts.cwd ?? process.cwd();

  // Built-in layer ships the catalog (providers + models) but NO
  // `currentProvider` / `currentModel` — a fresh install has no
  // preselected vendor. The user picks via `huko setup` or the
  // `provider current` / `model current` commands.
  const builtin: InfraConfigFile = {
    providers: BUILTIN_PROVIDERS,
    models: BUILTIN_MODELS,
  };
  const global = readJsonFile(globalConfigPath());
  const project = readJsonFile(projectConfigPath(cwd));

  return mergeLayers([
    { source: "builtin", file: builtin },
    { source: "global", file: global ?? {} },
    { source: "project", file: project ?? {} },
  ]);
}

type Layer = {
  source: ConfigSource;
  file: InfraConfigFile;
};

/**
 * Merge layers in order (lowest precedence first). Each later layer:
 *   - Overrides earlier provider entries by `name`
 *   - Overrides earlier model entries by `(providerName, modelId)`
 *   - Replaces `defaultModel` if set
 *   - Adds names to the disable lists
 *
 * Disable lists from any layer apply to entries from any layer except
 * entries the SAME layer also adds. (You can't disable what you just
 * added in the same file — that's a contradiction; use don't-add instead.)
 */
function mergeLayers(layers: Layer[]): InfraConfig {
  // Collect disable lists from all layers first — they apply globally.
  const disabledProviderNames = new Set<string>();
  const disabledModelKeys = new Set<string>();
  for (const layer of layers) {
    for (const n of layer.file.disabledProviders ?? []) {
      disabledProviderNames.add(n);
    }
    for (const m of layer.file.disabledModels ?? []) {
      disabledModelKeys.add(modelKey(m.providerName, m.modelId));
    }
  }

  // Walk layers in precedence order; later entries replace earlier ones
  // by primary key. Map preserves insertion order, but we re-key to put
  // overrides in their original-builtin position (nicer list output).
  const providersByName = new Map<string, ResolvedProvider>();
  for (const layer of layers) {
    for (const p of layer.file.providers ?? []) {
      // Allow a layer's own additions even if they're disabled by some
      // OTHER layer — same-layer additions win over same-layer disables.
      // (Mixed-layer disables still apply: project can disable a global
      // provider; built-ins can be disabled by either.)
      providersByName.set(p.name, { ...p, source: layer.source });
    }
  }
  // Apply disables now: drop providers whose name is on the list AND
  // weren't added by the highest-precedence layer that disabled them.
  // Simpler v1: just drop anything in the disable set. Re-add via
  // putting the entry in the same file as the disable would be silly.
  for (const name of disabledProviderNames) {
    providersByName.delete(name);
  }

  // Models: keyed by (providerName, modelId).
  const modelsByKey = new Map<string, ModelConfig & { source: ConfigSource }>();
  for (const layer of layers) {
    for (const m of layer.file.models ?? []) {
      modelsByKey.set(modelKey(m.providerName, m.modelId), {
        ...m,
        source: layer.source,
      });
    }
  }
  for (const k of disabledModelKeys) {
    modelsByKey.delete(k);
  }

  // currentProvider / currentModel: independent fields, each layered
  // project > global > builtin. Track which layer set each so the info
  // command can label "set in: global" / "set in: project" / etc.
  let currentProviderName: string | null = null;
  let currentProviderSource: ConfigSource | null = null;
  let currentModelId: string | null = null;
  let currentModelSource: ConfigSource | null = null;
  for (const layer of layers) {
    if (layer.file.currentProvider !== undefined) {
      currentProviderName = layer.file.currentProvider;
      currentProviderSource = layer.source;
    }
    if (layer.file.currentModel !== undefined) {
      currentModelId = layer.file.currentModel;
      currentModelSource = layer.source;
    }
  }

  // Resolve models to include their provider; drop orphans.
  const providers = [...providersByName.values()];
  const providerByName = (name: string): ResolvedProvider | null => {
    return providersByName.get(name) ?? null;
  };

  const resolvedModels: ResolvedModel[] = [];
  for (const m of modelsByKey.values()) {
    const provider = providerByName(m.providerName);
    if (!provider) continue;
    resolvedModels.push({ ...m, provider });
  }

  // Resolve the pointers. If the pointer references something that
  // doesn't exist in the merged set (orphan), the resolved value is
  // null but the source is preserved — info can show "(unresolved)".
  const currentProvider: ResolvedProvider | null =
    currentProviderName !== null ? providerByName(currentProviderName) : null;
  const currentModel: ResolvedModel | null =
    currentProviderName !== null && currentModelId !== null
      ? resolvedModels.find(
          (m) =>
            m.providerName === currentProviderName &&
            m.modelId === currentModelId,
        ) ?? null
      : null;

  return {
    providers,
    models: resolvedModels,
    currentProvider,
    currentProviderSource,
    currentModel,
    currentModelSource,
  };
}

// ─── Lookup helpers ─────────────────────────────────────────────────────────

export function findProvider(
  infra: InfraConfig,
  name: string,
): ResolvedProvider | null {
  return infra.providers.find((p) => p.name === name) ?? null;
}

export function findModel(
  infra: InfraConfig,
  providerName: string,
  modelId: string,
): ResolvedModel | null {
  return (
    infra.models.find(
      (m) => m.providerName === providerName && m.modelId === modelId,
    ) ?? null
  );
}

// ─── File readers / writers ─────────────────────────────────────────────────

/** Path to the global infra config file. */
export function globalConfigPath(): string {
  return path.join(os.homedir(), ".huko", "providers.json");
}

/** Path to the project infra config file for `cwd`. */
export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".huko", "providers.json");
}

/**
 * Read and parse a config file. Returns `null` if the file is absent.
 * Throws (with the path in the message) on malformed JSON or non-object
 * content, so the user can find and fix the broken file.
 */
function readJsonFile(p: string): InfraConfigFile | null {
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`infra-config: cannot read ${p}: ${describe(err)}`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`infra-config: ${p} is not valid JSON: ${describe(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`infra-config: ${p} must contain a JSON object at top level`);
  }
  // We intentionally don't deeply validate here — the merger tolerates
  // missing/extra fields. Callers operate on the resolved shape.
  return parsed as InfraConfigFile;
}

export function readGlobalConfigFile(): InfraConfigFile {
  return readJsonFile(globalConfigPath()) ?? {};
}

export function readProjectConfigFile(cwd: string): InfraConfigFile {
  return readJsonFile(projectConfigPath(cwd)) ?? {};
}

/**
 * Write a config file atomically (write-then-rename). Auto-creates
 * `<dir>/.huko/`. Pretty-printed with 2-space indent so it diffs nicely
 * if it's checked into git.
 */
function writeJsonFile(p: string, file: InfraConfigFile): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  // renameSync is atomic on every fs we care about (POSIX, NTFS).
  try {
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow — temp leaked, not fatal */
    }
    throw err;
  }
}

export function writeGlobalConfigFile(file: InfraConfigFile): void {
  writeJsonFile(globalConfigPath(), file);
}

export function writeProjectConfigFile(cwd: string, file: InfraConfigFile): void {
  writeJsonFile(projectConfigPath(cwd), file);
}

// ─── Internals ──────────────────────────────────────────────────────────────

function modelKey(providerName: string, modelId: string): string {
  // `\0` separator — modelIds can contain `/` and `:` so a printable
  // separator could collide.
  return `${providerName}\0${modelId}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
