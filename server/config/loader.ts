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
} from "./types.js";

// ─── Module-global cached config ─────────────────────────────────────────────

let resolvedConfig: HukoConfig = DEFAULT_CONFIG;
let resolvedLayers: ConfigSourceLayer[] = [
  { source: "default", raw: DEFAULT_CONFIG },
];
let loaded = false;

/**
 * Get the current resolved config. Returns DEFAULT_CONFIG until
 * `loadConfig()` has been called at least once, so kernel modules can
 * safely import-and-use without ordering hassle (they'll just see
 * defaults if loadConfig hasn't fired yet).
 */
export function getConfig(): HukoConfig {
  return resolvedConfig;
}

/** Diagnostic: which layers contributed, in priority order (low → high). */
export function getConfigLayers(): ConfigSourceLayer[] {
  return resolvedLayers;
}

/** Has loadConfig() been called? */
export function isConfigLoaded(): boolean {
  return loaded;
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

  // 4. Explicit programmatic override
  if (options.explicit) {
    layers.push({ source: "explicit", raw: options.explicit });
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
  type Bucket = "deny" | "allow" | "requireConfirm";
  const buckets: Bucket[] = ["deny", "allow", "requireConfirm"];
  const accum = new Map<string, string[]>();

  for (const layer of layers) {
    const raw = layer.raw as { safety?: { toolRules?: Record<string, unknown> } };
    const toolRules = raw.safety?.toolRules;
    if (!toolRules || typeof toolRules !== "object") continue;
    for (const [toolName, rawRules] of Object.entries(toolRules)) {
      if (!rawRules || typeof rawRules !== "object") continue;
      const rr = rawRules as Record<string, unknown>;
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
  const merged_toolRules: Record<string, { deny?: string[]; allow?: string[]; requireConfirm?: string[] }> = {};
  for (const [key, list] of accum) {
    if (list.length === 0) continue;
    const [toolName, bucket] = key.split("::") as [string, Bucket];
    const entry = merged_toolRules[toolName] ?? {};
    entry[bucket] = list;
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
  loaded = true;
}

/**
 * Test-only: reset to defaults, mark unloaded.
 */
export function resetConfigForTests(): void {
  resolvedConfig = DEFAULT_CONFIG;
  resolvedLayers = [{ source: "default", raw: DEFAULT_CONFIG }];
  loaded = false;
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
