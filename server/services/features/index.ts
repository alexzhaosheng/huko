/**
 * server/services/features/index.ts
 *
 * Barrel exports for the feature bundle subsystem.
 */

export type {
  Feature,
  FeaturesConfig,
  Sidecar,
  SidecarDeps,
} from "./registry.js";
export {
  assertNoNameCollisionsWithTools,
  computeEnabledFeatures,
  getFeature,
  listFeatures,
  registerFeature,
} from "./registry.js";
export {
  startEnabledSidecars,
  stopAllSidecars,
  type StartResult,
} from "./sidecars.js";
