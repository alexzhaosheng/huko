/**
 * server/config/index.ts
 *
 * Public surface of the config subsystem.
 *
 * Two configuration scopes live here:
 *
 *   1. `HukoConfig` — runtime knobs (timeouts, log levels, role
 *      defaults). Layered defaults → ~/.huko/config.json →
 *      <cwd>/.huko/config.json → env. Loaded once via `loadConfig()`,
 *      snapshotted by `getConfig()`. See loader.ts.
 *
 *   2. `InfraConfig` — providers, models, default model. Layered
 *      built-in → ~/.huko/providers.json → <cwd>/.huko/providers.json.
 *      Loaded on demand via `loadInfraConfig({ cwd })`. See infra-config.ts.
 *
 * The two are independent; nothing forces them to be loaded together.
 * Bootstrap calls both during startup.
 */

// ── Runtime config ──────────────────────────────────────────────────────────

export {
  getConfig,
  getConfigLayers,
  isConfigLoaded,
  loadConfig,
  setConfigForTests,
  resetConfigForTests,
  type LoadConfigOptions,
} from "./loader.js";

export {
  DEFAULT_CONFIG,
  type HukoConfig,
  type ConfigSourceLayer,
} from "./types.js";

// ── Writers (path-based set/get/unset) ──────────────────────────────────────
//
// NOTE: `globalConfigPath` / `projectConfigPath` from this barrel point
// at `providers.json`. The runtime-config writer (config.json) lives in
// `./writer.js` and exposes its own paths there — import it directly to
// avoid the naming collision.

export {
  type ConfigScope,
  setConfigValue,
  unsetConfigValue,
  getValueByPath,
  inferPathSchema,
  readLayerFile,
  parsePath,
} from "./writer.js";

// ── Infra config (providers / models / default model) ───────────────────────

export {
  loadInfraConfig,
  findProvider,
  findModel,
  globalConfigPath,
  projectConfigPath,
  readGlobalConfigFile,
  readProjectConfigFile,
  writeGlobalConfigFile,
  writeProjectConfigFile,
  type LoadInfraConfigOptions,
} from "./infra-config.js";

export type {
  ConfigSource,
  InfraConfig,
  InfraConfigFile,
  ModelConfig,
  ProviderConfig,
  ProviderModelRef,
  ResolvedModel,
  ResolvedProvider,
} from "./infra-config-types.js";

export {
  BUILTIN_PROVIDERS,
  BUILTIN_MODELS,
} from "./builtin-providers.js";
