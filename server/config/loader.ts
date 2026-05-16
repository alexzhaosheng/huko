/**
 * server/config/loader.ts
 *
 * Load + merge huko config from layered sources.
 *
 * Discovery order (low → high priority):
 *   1. DEFAULT_CONFIG (built-in)
 *   2. ~/.huko/config.json                 (user-global)
 *   3. <cwd>/.huko/config.json             (project-local)
 *   4. process.env.HUKO_CONFIG=<path>      (explicit env override)
 *   5. opts.explicit                        (programmatic override — tests, CLI flags)
 *
 * Each layer is shallow-merged onto the running result, recursively
 * for nested objects. Missing keys inherit from lower layers; present
 * keys override.
 *
 * The loader is invoked once at bootstrap (CLI `bootstrap.ts`, daemon
 * `core/app.ts`); the resolved config is then accessible globally via
 * `getConfig()`. There is no hot-reload — config changes take effect
 * on the next process start.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_CONFIG,
  type ConfigSourceLayer,
  type HukoConfig,
  type ToolSafetyRules,
} from "./types.js";

// ─── Module-global cached config ─────────────────────────────────────────────

let resolvedConfig: HukoConfig = DEFAULT_CONFIG;
let resolvedLayers: ConfigSourceLayer[] = [
  { source: "default", raw: DEFAULT_CONFIG },
];
let loaded = false;

// Accumulated programmatic overrides applied at every load. Populated
// by `extendExplicitOverride` so multiple subsystems (CLI flags at
// startup + slash commands mid-chat) can stack their own slices
// without clobbering each other. `loadConfig({explicit:X})` REPLACES
// this; `extendExplicitOverride(X)` MERGES into it.
let runtimeOverride: Partial<HukoConfig> = {};
let lastCwd: string = process.cwd();

/**
 * Get the current resolved config. Auto-loads from `process.cwd()` on
 * first access — callers do NOT have to call `loadConfig()` first.
 *
 * Why the auto-load: every CLI command + every kernel module that
 * reads config used to start with `loadConfig({ cwd: process.cwd() })`,
 * with apologetic comments like "bootstrap usually does this, but X
 * can run before bootstrap." That's exactly the "remember to call A
 * before B" smell — lifting it into `getConfig()` makes the prep
 * structural rather than convention-bound.
 *
 * If a caller needs to override (tests with `explicit`, or daemon
 * paths that boot from a non-cwd directory), they still call
 * `loadConfig({...})` explicitly — that wins over the lazy load.
 */
export function getConfig(): HukoConfig {
  if (!loaded) {
    loadConfig({});
  }
  return resolvedConfig;
}

/** Diagnostic: which layers contributed, in priority order (low → high). */
export function getConfigLayers(): ConfigSourceLayer[] {
  if (!loaded) loadConfig({});
  return resolvedLayers;
}


// ─── Loader ──────────────────────────────────────────────────────────────────

export type LoadConfigOptions = {
  /** Working directory for project-local discovery. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Explicit overrides (tests / CLI flags). Highest priority — applied
   * AFTER all file/env layers.
   */
  explicit?: Partial<HukoConfig>;
};

export function loadConfig(options: LoadConfigOptions = {}): HukoConfig {
  const cwd = options.cwd ?? process.cwd();
  lastCwd = cwd;
  // `explicit` REPLACES the runtime overlay — keeps backward compat
  // with tests that pass a fully-formed override and expect no leftovers.
  // To MERGE additively (mid-chat slash commands), use extendExplicitOverride.
  if (options.explicit !== undefined) {
    runtimeOverride = options.explicit;
  }
  const layers: ConfigSourceLayer[] = [
    { source: "default", raw: DEFAULT_CONFIG },
  ];

  // 1. User-global
  const userPath = path.join(os.homedir(), ".huko", "config.json");
  const userRaw = tryReadJson(userPath);
  if (userRaw) layers.push({ source: "user", path: userPath, raw: userRaw });

  // 2. Project-local
  const projectPath = path.join(cwd, ".huko", "config.json");
  const projectRaw = tryReadJson(projectPath);
  if (projectRaw) layers.push({ source: "project", path: projectPath, raw: projectRaw });

  // 3. Env override path
  const envPath = process.env["HUKO_CONFIG"];
  if (envPath && envPath.length > 0) {
    const envRaw = tryReadJson(envPath);
    if (envRaw) layers.push({ source: "env", path: envPath, raw: envRaw });
  }

  // 4. Explicit programmatic override (accumulated across calls)
  if (Object.keys(runtimeOverride).length > 0) {
    layers.push({ source: "explicit", raw: runtimeOverride });
  }

  // Merge in priority order (each subsequent overlays previous).
  let result: HukoConfig = DEFAULT_CONFIG;
  for (const layer of layers) {
    result = deepMerge(result, layer.raw) as HukoConfig;
  }

  // Override: `safety.toolRules.<tool>.{deny,allow,requireConfirm}` are
  // UNION-merged across layers, not replaced. Safety constraints are
  // additive — project never silently relaxes global. This is the
  // loader's only array-merge exception; everywhere else, arrays in a
  // higher layer replace arrays in a lower layer.
  result = applyToolRulesUnion(result, layers);

  resolvedConfig = result;
  resolvedLayers = layers;
  loaded = true;
  return result;
}

function applyToolRulesUnion(merged: HukoConfig, layers: ConfigSourceLayer[]): HukoConfig {
  // Collect contributions from EVERY layer (default included). Keys
  // are `<toolName>::<bucket>`; values are de-duped string lists.
  // `disabled` is OR'd across layers — any layer setting `true` wins;
  // `false` is treated as absent (the field can only assert disablement,
  // never re-enable a lower layer's disable).
  type Bucket = "deny" | "allow" | "requireConfirm";
  const buckets: Bucket[] = ["deny", "allow", "requireConfirm"];
  const accum = new Map<string, string[]>();
  const disabled = new Set<string>();

  for (const layer of layers) {
    const raw = layer.raw as { safety?: { toolRules?: Record<string, unknown> } };
    const toolRules = raw.safety?.toolRules;
    if (!toolRules || typeof toolRules !== "object") continue;
    for (const [toolName, rawRules] of Object.entries(toolRules)) {
      if (!rawRules || typeof rawRules !== "object") continue;
      const rr = rawRules as Record<string, unknown>;
      if (rr["disabled"] === true) disabled.add(toolName);
      for (const bucket of buckets) {
        const arr = rr[bucket];
        if (!Array.isArray(arr)) continue;
        const key = `${toolName}::${bucket}`;
        const cur = accum.get(key) ?? [];
        for (const p of arr) {
          if (typeof p === "string" && p.length > 0 && !cur.includes(p)) {
            cur.push(p);
          }
        }
        accum.set(key, cur);
      }
    }
  }

  // Build the merged toolRules from the accumulator.
  const merged_toolRules: Record<string, ToolSafetyRules> = {};
  for (const [key, list] of accum) {
    if (list.length === 0) continue;
    const [toolName, bucket] = key.split("::") as [string, Bucket];
    const entry = merged_toolRules[toolName] ?? {};
    entry[bucket] = list;
    merged_toolRules[toolName] = entry;
  }
  // Apply disabled flags last — may add tools that have ONLY a disable
  // and no rule lists.
  for (const toolName of disabled) {
    const entry = merged_toolRules[toolName] ?? {};
    entry.disabled = true;
    merged_toolRules[toolName] = entry;
  }

  return {
    ...merged,
    safety: {
      ...merged.safety,
      toolRules: merged_toolRules,
    },
  };
}

/**
 * Test-only: reset the module-global config to a known value.
 * Production code should call `loadConfig()` instead.
 */
export function setConfigForTests(c: HukoConfig): void {
  resolvedConfig = c;
  resolvedLayers = [{ source: "explicit", raw: c }];
  runtimeOverride = {};
  loaded = true;
}

/**
 * Test-only: reset to defaults, mark unloaded.
 */
export function resetConfigForTests(): void {
  resolvedConfig = DEFAULT_CONFIG;
  resolvedLayers = [{ source: "default", raw: DEFAULT_CONFIG }];
  runtimeOverride = {};
  loaded = false;
}

/**
 * Deep-merge `partial` into the accumulated runtime override and
 * re-resolve. Use this when one subsystem needs to add to the explicit
 * layer without wiping another subsystem's overrides — e.g. bootstrap
 * sets `{features}`, then a chat slash command sets `{compaction}` and
 * the merged explicit becomes `{features, compaction}`.
 *
 * Distinct from `loadConfig({explicit:X})`, which REPLACES the runtime
 * override wholesale (kept for test backward-compat).
 */
export function extendExplicitOverride(partial: Partial<HukoConfig>): HukoConfig {
  runtimeOverride = deepMerge(runtimeOverride, partial) as Partial<HukoConfig>;
  return loadConfig({ cwd: lastCwd });
}

// ─── Internals ───────────────────────────────────────────────────────────────

function tryReadJson(p: string): Partial<HukoConfig> | null {
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Strip _comment keys — by convention, callers can write
      // `{ "_comment": "...", "task": { ... } }` for human readers.
      return stripCommentKeys(parsed as Record<string, unknown>) as Partial<HukoConfig>;
    }
    return null;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") return null; // missing file is OK
    }
    // Malformed JSON or read error — log to stderr but don't crash. The
    // operator gets defaults instead of a startup failure on a typo.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: warning — failed to read config ${p}: ${msg}\n`);
    return null;
  }
}

function stripCommentKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("_comment")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripCommentKeys(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Recursive deep-merge for plain objects. Arrays are replaced wholesale,
 * not concatenated — matches typical config-file mental model ("set this
 * list" rather than "append to inherited list").
 */
function deepMerge(base: unknown, overlay: unknown): unknown {
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    !overlay ||
    typeof overlay !== "object" ||
    Array.isArray(overlay)
  ) {
    return overlay !== undefined ? overlay : base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge(out[k], v);
  }
  return out;
}
