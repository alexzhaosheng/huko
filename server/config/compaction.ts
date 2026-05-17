/**
 * server/config/compaction.ts
 *
 * Effective compaction-tuning resolver.
 *
 * Two knobs coexist in `HukoConfig.compaction`:
 *
 *   - `level: "concise" | "standard" | "extended" | "large" | "max"`
 *     — the high-level preset (default "standard"). Each preset maps
 *     to an absolute target-token count in COMPACTION_LEVEL_TARGETS
 *     (or, for "max", to 95% of the active model's context window).
 *
 *   - `thresholdRatio` / `targetRatio` — raw ratios. When EITHER is
 *     present in any layer (typically because the operator ran
 *     `huko config set compaction.thresholdRatio 0.4` or passed
 *     `--compact-threshold=0.4`), they override the preset and the
 *     effective mode flips to "custom".
 *
 * The resolver maps `(config, modelWindow)` →
 *   `{ thresholdRatio, targetRatio, display, source }`
 *
 * where:
 *   - `thresholdRatio` / `targetRatio` are the numbers
 *     `manageContext` actually uses.
 *   - `display` is the human-friendly label ("standard" / "custom" / etc).
 *   - `source` is the same label, but specifically intended for
 *     telemetry / info dumps (lets callers print "extended (~12%)").
 *
 * The clamp `min(level_target, modelWindow * 0.95)` is intentional:
 * picking `level: large` on a 32k model should degrade to "as much as
 * 32k allows" rather than refusing to compact. Operators get what
 * their hardware can deliver.
 */

import {
  COMPACTION_LEVEL_TARGETS,
  type CompactionLevel,
  type HukoConfig,
} from "./types.js";

/** Cap on the effective compaction trigger as a fraction of context window. */
const MAX_RATIO = 0.95;

/** Standard 20% gap between threshold and target (matches old defaults). */
const TARGET_GAP = 0.2;

/** Lowest sensible targetRatio after gap subtraction. */
const MIN_TARGET_RATIO = 0.1;

export type ResolvedCompaction = {
  /** The trigger ratio the kernel uses (0 < r ≤ MAX_RATIO). */
  thresholdRatio: number;
  /** The post-compaction budget ratio (always thresholdRatio - TARGET_GAP, floored at MIN_TARGET_RATIO). */
  targetRatio: number;
  /** Human-friendly label for banners / info / `/compact` echoes. */
  display: CompactionLevel | "custom";
};

/**
 * Resolve the effective compaction tuning. Pure function — no I/O, no
 * mutation, suitable for inlining wherever the kernel needs the live
 * ratios.
 *
 * `modelWindow` is the active model's context-window in tokens, which
 * may have come from the per-model override (`models.contextWindow`)
 * or the heuristic table — the resolver doesn't care, it just needs a
 * positive number.
 */
export function resolveCompaction(
  cfg: HukoConfig["compaction"],
  modelWindow: number,
): ResolvedCompaction {
  // Custom path: an explicit raw ratio wins over any preset. We treat
  // a present-but-out-of-range `thresholdRatio` as user error and clamp
  // rather than throw — the value came through config validation
  // already (CLI parser rejects [<0.05, >0.99]), so seeing it here
  // means a hand-edited config file; clamp + display "custom".
  if (cfg.thresholdRatio !== undefined) {
    const t = clamp(cfg.thresholdRatio, MIN_TARGET_RATIO, MAX_RATIO);
    const target =
      cfg.targetRatio !== undefined
        ? clamp(cfg.targetRatio, MIN_TARGET_RATIO, t - 0.05)
        : Math.max(MIN_TARGET_RATIO, t - TARGET_GAP);
    return { thresholdRatio: t, targetRatio: target, display: "custom" };
  }

  // Preset path: map level → absolute target, then clamp to window.
  const level = cfg.level;
  const ratio = ratioForLevel(level, modelWindow);
  const target = Math.max(MIN_TARGET_RATIO, ratio - TARGET_GAP);
  return { thresholdRatio: ratio, targetRatio: target, display: level };
}

/**
 * Compute the effective trigger ratio for a preset on a given window.
 * Exported separately so the `huko info` dump can show "if you switched
 * to `extended` you'd be at 12.5%" previews without having to call
 * resolveCompaction with a synthetic config.
 */
export function ratioForLevel(level: CompactionLevel, modelWindow: number): number {
  if (level === "max") return MAX_RATIO;
  const target = COMPACTION_LEVEL_TARGETS[level];
  if (modelWindow <= 0) return MAX_RATIO; // defensive — bad input, give max
  // Only clamp the UPPER bound: on huge windows the math legitimately
  // produces small ratios (e.g. 32k on a 1M window = 3.2%, which is
  // fine — compaction kicks in at 32k tokens of conversation). The
  // MIN_TARGET_RATIO floor only applies to the derived target, not the
  // trigger threshold itself.
  return Math.min(target / modelWindow, MAX_RATIO);
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
