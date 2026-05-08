/**
 * server/config/index.ts
 *
 * Public surface of the config subsystem.
 *
 * Read pattern: at module top, `const config = getConfig()`. Use values
 * in handlers/closures. There is NO hot-reload — values are snapshotted
 * at the time `getConfig()` first runs, and `loadConfig()` should have
 * already been called by bootstrap.
 *
 * Write pattern: only bootstrap entry points call `loadConfig()`.
 * Tests use `setConfigForTests()` to inject.
 */

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
