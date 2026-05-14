/**
 * server/services/features/registry.ts
 *
 * Feature bundle registry — chat-mode opt-in groups of tools and/or a
 * sidecar service.
 *
 * A Feature has:
 *   - a `name` (shares namespace with tool names; collision checked at
 *     bootstrap via `assertNoNameCollisionsWithTools`)
 *   - an `enabledByDefault` flag (heavyweight features ship false)
 *   - optionally a `Sidecar` (long-lived listener spawned in chat mode)
 *
 * Tools associate to features by their `feature?: string` tag (see
 * `server/task/tools/registry.ts`). When a feature is disabled, the
 * tool registry filters its tools out of `getToolsForLLM` and
 * `getToolPromptHints` — zero LLM-visible surface, zero token cost.
 *
 * The "chat-mode only" property of sidecars is structural, not a
 * runtime check inside the sidecar: only chat-mode bootstrap calls
 * `startEnabledSidecars()`, so a sidecar never runs outside that mode
 * to begin with.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SidecarDeps = {
  /** Project root (cwd). For sidecars that need fs paths within the project. */
  projectRoot: string;
};

export type Sidecar = {
  start(deps: SidecarDeps): Promise<void>;
  stop(): Promise<void>;
};

export type Feature = {
  name: string;
  enabledByDefault: boolean;
  sidecar?: Sidecar;
};

/**
 * Shape of the user-level feature override map (e.g. parsed from
 * `~/.huko/config.json` `features` section or CLI `--enable=X`).
 * `enabled` absent → fall back to the feature's `enabledByDefault`.
 */
export type FeaturesConfig = Record<string, { enabled?: boolean }>;

// ─── Registry state ──────────────────────────────────────────────────────────

const features = new Map<string, Feature>();

export function registerFeature(f: Feature): void {
  if (features.has(f.name)) {
    throw new Error(`Feature "${f.name}" is already registered.`);
  }
  features.set(f.name, f);
}

export function getFeature(name: string): Feature | undefined {
  return features.get(name);
}

export function listFeatures(): Feature[] {
  return [...features.values()];
}

// ─── Enabled set computation ─────────────────────────────────────────────────

/**
 * For every registered feature, decide whether it ends up enabled:
 *   1. If `cfg[name].enabled` is a boolean, that wins (explicit override).
 *   2. Otherwise fall back to the feature's `enabledByDefault`.
 *
 * Step-3 bootstrap pipes the resulting Set into `setEnabledFeatures()`
 * in `server/task/tools/registry.ts` so feature-tagged tools are
 * filtered accordingly, and uses the same Set to drive
 * `startEnabledSidecars()`.
 */
export function computeEnabledFeatures(cfg: FeaturesConfig = {}): Set<string> {
  const out = new Set<string>();
  for (const f of features.values()) {
    const override = cfg[f.name]?.enabled;
    const enabled = override !== undefined ? override : f.enabledByDefault;
    if (enabled) out.add(f.name);
  }
  return out;
}

// ─── Cross-registry validation ───────────────────────────────────────────────

/**
 * Tool names and feature names share a namespace so `--enable=X` /
 * `--disable=X` resolve unambiguously. Call this at bootstrap, after
 * both registries are populated, to fail loud on collision.
 *
 * The check lives here (rather than in the tool registry) so the
 * dependency points the right way: features know they coordinate
 * tools; tools do not know features exist.
 */
export function assertNoNameCollisionsWithTools(toolNames: Iterable<string>): void {
  const toolSet = new Set(toolNames);
  for (const name of features.keys()) {
    if (toolSet.has(name)) {
      throw new Error(
        `Feature name "${name}" collides with an existing tool name. ` +
          `Pick a different feature name or rename the tool.`,
      );
    }
  }
}

/** Test-only: clear all feature registrations. Not exported from the barrel. */
export function _resetFeatureRegistryForTests(): void {
  features.clear();
}
