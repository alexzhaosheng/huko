/**
 * server/cli/commands/info.ts
 *
 * `huko info [scope]` — show the currently effective configuration.
 *
 * Modes:
 *   - `huko info`           effective view: shows the currently active
 *                           provider + model with full details, labeled
 *                           with which layer set each pointer.
 *   - `huko info global`    same shape, but for what global's pointers
 *                           would set (regardless of project overrides).
 *   - `huko info project`   what project's pointers set (often empty).
 *
 * No `builtin` scope: huko's built-in defaults are already visible in
 * the merged view (the source column says `builtin` when a layer's
 * pointer wasn't set). To see the full set of built-in entries, use
 * `huko provider list` / `huko model list`.
 *
 * Provider/model LISTS aren't shown here — `huko provider list` and
 * `huko model list` already cover those. `info` is the focused view:
 * "what's actually going to run if I type `huko`".
 *
 * Sections in text mode:
 *   1. Header   — cwd + scope label
 *   2. Current provider — full details (URL, protocol, key resolution)
 *   3. Current model    — full details (display name, think/tool flags)
 *   4. Config files     — paths + existence (only in merged view)
 *
 * `--json` / `--jsonl` produce machine-readable output. The shape is
 * stable: { header, currentProvider, currentModel, files? }.
 *
 * Exit codes:
 *   0 ok    1 internal error    3 usage error
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigLayers,
  getValueByPath,
  loadInfraConfig,
  parsePath,
  type ConfigSource,
  type ConfigSourceLayer,
  type InfraConfig,
  type ResolvedModel,
  type ResolvedProvider,
} from "../../config/index.js";
import { estimateContextWindow } from "../../core/llm/model-context-window.js";
import { getConfig, resolveCompaction } from "../../config/index.js";
import { getHukoVersion, getBuildInfo } from "../../version.js";
import {
  describeKeySource,
  globalKeysPath,
  projectKeysPath,
} from "../../security/keys.js";
import {
  globalConfigPath,
  projectConfigPath,
  readGlobalConfigFile,
  readProjectConfigFile,
} from "../../config/infra-config.js";
import {
  bold,
  dim,
  emphasis,
  green,
  header,
  keyStatus,
  red,
  source,
  yellow,
} from "../colors.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type InfoScope = "all" | "global" | "project";

export type InfoArgs = {
  scope: InfoScope;
  format: OutputFormat;
};

type Effective = {
  /** The provider+model pair this scope picks, fully resolved. */
  currentProvider: ResolvedProvider | null;
  currentProviderSource: ConfigSource | null;
  currentModel: ResolvedModel | null;
  currentModelSource: ConfigSource | null;
  /** Runtime-config mode + which layer set it (null if unset in this scope). */
  mode: { value: "lean" | "full"; source: RuntimeSource | null };
  /** Non-default runtime-config overrides (excluding `mode`, shown separately). */
  runtimeOverrides: RuntimeOverride[];
};

type RuntimeSource = ConfigSourceLayer["source"];

type RuntimeOverride = {
  /** Dot path, e.g. `task.maxIterations`. */
  path: string;
  value: unknown;
  source: RuntimeSource;
  layerPath?: string;
};

export async function infoCommand(args: InfoArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const cfg = loadInfraConfig({ cwd });
    const eff = effectiveForScope(cfg, args.scope, cwd);

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(buildPayload(eff, cwd, args.scope), null, 2) + "\n");
      return 0;
    }
    if (args.format === "jsonl") {
      const payload = buildPayload(eff, cwd, args.scope);
      process.stdout.write(JSON.stringify({ type: "header", ...payload.header }) + "\n");
      process.stdout.write(
        JSON.stringify({ type: "currentMode", ...payload.currentMode }) + "\n",
      );
      for (const o of payload.runtimeOverrides) {
        process.stdout.write(JSON.stringify({ type: "runtimeOverride", ...o }) + "\n");
      }
      if (payload.currentProvider) {
        process.stdout.write(
          JSON.stringify({ type: "currentProvider", ...payload.currentProvider }) + "\n",
        );
      }
      if (payload.currentModel) {
        process.stdout.write(
          JSON.stringify({ type: "currentModel", ...payload.currentModel }) + "\n",
        );
      }
      for (const f of payload.files) {
        process.stdout.write(JSON.stringify({ type: "file", ...f }) + "\n");
      }
      return 0;
    }

    printText(eff, cwd, args.scope);
    return 0;
  } catch (err) {
    process.stderr.write(`huko: info failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── Effective resolver per scope ───────────────────────────────────────────

/**
 * Per-scope "what would the current pointer be?":
 *   - `all`     → the merged result (project > global > builtin).
 *   - `global`  → what `~/.huko/providers.json` itself sets (could be
 *                 nothing if the user hasn't written `currentProvider`
 *                 / `currentModel` there).
 *   - `project` → same for `<cwd>/.huko/providers.json`.
 *
 * In each case we still resolve the names against the FULL merged
 * provider/model set so the user sees full details (URL, protocol,
 * etc.) even when the entity definition lives in a different layer.
 */
function effectiveForScope(cfg: InfraConfig, scope: InfoScope, cwd: string): Effective {
  const runtimeLayers = getConfigLayers();
  const runtime = runtimeForScope(scope, runtimeLayers);

  if (scope === "all") {
    return {
      currentProvider: cfg.currentProvider,
      currentProviderSource: cfg.currentProviderSource,
      currentModel: cfg.currentModel,
      currentModelSource: cfg.currentModelSource,
      mode: runtime.mode,
      runtimeOverrides: runtime.overrides,
    };
  }

  let providerName: string | undefined;
  let modelId: string | undefined;
  let layer: ConfigSource;

  if (scope === "global") {
    layer = "global";
    const file = readGlobalConfigFile();
    providerName = file.currentProvider;
    modelId = file.currentModel;
  } else {
    // scope === "project"
    layer = "project";
    const file = readProjectConfigFile(cwd);
    providerName = file.currentProvider;
    modelId = file.currentModel;
  }

  const currentProvider =
    providerName !== undefined
      ? cfg.providers.find((p) => p.name === providerName) ?? null
      : null;
  const currentModel =
    providerName !== undefined && modelId !== undefined
      ? cfg.models.find((m) => m.providerName === providerName && m.modelId === modelId) ??
        null
      : null;

  return {
    currentProvider,
    currentProviderSource: providerName !== undefined ? layer : null,
    currentModel,
    currentModelSource: modelId !== undefined ? layer : null,
    mode: runtime.mode,
    runtimeOverrides: runtime.overrides,
  };
}

// ─── Runtime config (HukoConfig) resolution ─────────────────────────────────

/**
 * Find the highest-priority layer that contains `path`. Returns null if
 * no layer has it set (in practice `default` always covers since
 * DEFAULT_CONFIG is layer 0).
 */
function findLayerForPath(
  layers: ConfigSourceLayer[],
  path: string[],
): ConfigSourceLayer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (getValueByPath(layers[i]!.raw as unknown, path) !== undefined) {
      return layers[i]!;
    }
  }
  return null;
}

/** Recursively enumerate all primitive leaves of an object with dot-paths. */
function walkLeaves(obj: unknown, prefix: string = ""): Array<{ path: string; value: unknown }> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return [{ path: prefix, value: obj }];
  }
  const out: Array<{ path: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix === "" ? k : `${prefix}.${k}`;
    out.push(...walkLeaves(v, next));
  }
  return out;
}

type RuntimeView = {
  mode: { value: "lean" | "full"; source: RuntimeSource | null };
  overrides: RuntimeOverride[];
};

/**
 * Per-scope runtime-config view:
 *   - `all`     → effective `mode` from layered merge; `overrides` = every
 *                 non-`mode` leaf whose effective value comes from a layer
 *                 above `default`.
 *   - `global`  → what `~/.huko/config.json` itself sets (could be empty);
 *                 `mode` shows only if global sets it.
 *   - `project` → same for `<cwd>/.huko/config.json`.
 *
 * Reading the SPECIFIC layer (not merge) matches how the provider/model
 * scope view works above.
 */
function runtimeForScope(scope: InfoScope, layers: ConfigSourceLayer[]): RuntimeView {
  if (scope === "all") {
    const modeLayer = findLayerForPath(layers, ["mode"]);
    const modeVal = modeLayer ? (getValueByPath(modeLayer.raw as unknown, ["mode"]) as "lean" | "full") : "full";
    const modeSource = modeLayer ? modeLayer.source : null;

    // Walk DEFAULT_CONFIG-shaped leaves via the topmost merged result —
    // we get that by walking the highest-priority layer's effective view.
    // Simpler: iterate every leaf path that any layer above `default`
    // sets, dedup by path.
    const overridenPaths = new Set<string>();
    for (const layer of layers) {
      if (layer.source === "default") continue;
      for (const { path } of walkLeaves(layer.raw)) {
        if (path === "mode") continue; // shown separately
        overridenPaths.add(path);
      }
    }

    const overrides: RuntimeOverride[] = [];
    for (const p of [...overridenPaths].sort()) {
      const parts = parsePath(p);
      const winner = findLayerForPath(layers, parts);
      if (!winner) continue;
      const value = getValueByPath(winner.raw as unknown, parts);
      overrides.push({
        path: p,
        value,
        source: winner.source,
        ...(winner.path !== undefined ? { layerPath: winner.path } : {}),
      });
    }

    return {
      mode: { value: modeVal, source: modeSource },
      overrides,
    };
  }

  // scope === "global" | "project" — read THAT layer's raw payload only.
  const targetSource: RuntimeSource = scope === "global" ? "user" : "project";
  const layer = layers.find((l) => l.source === targetSource);

  if (!layer) {
    return {
      mode: { value: "full", source: null },
      overrides: [],
    };
  }

  const modeVal = getValueByPath(layer.raw as unknown, ["mode"]);
  const modeRecord = modeVal === "lean" || modeVal === "full"
    ? { value: modeVal as "lean" | "full", source: layer.source }
    : { value: "full" as const, source: null };

  const overrides: RuntimeOverride[] = [];
  for (const leaf of walkLeaves(layer.raw)) {
    if (leaf.path === "mode") continue;
    overrides.push({
      path: leaf.path,
      value: leaf.value,
      source: layer.source,
      ...(layer.path !== undefined ? { layerPath: layer.path } : {}),
    });
  }
  overrides.sort((a, b) => a.path.localeCompare(b.path));

  return { mode: modeRecord, overrides };
}

/**
 * Map runtime source labels onto the `ConfigSource` vocabulary the rest
 * of `huko info` uses ("builtin" | "global" | "project") so the same
 * color helper (`source()` in colors.ts) handles both domains.
 *
 *   - default  → builtin   (both = "the base layer")
 *   - user     → global    (~/.huko/ is "global" in huko's vocabulary)
 *   - project  → project   (unchanged)
 *   - env      → global    (HUKO_CONFIG-pointed file — treat as a global
 *                           override; rare in practice)
 *   - explicit → global    (programmatic, e.g. test fixtures — also rare)
 */
function displaySource(s: RuntimeSource): ConfigSource {
  if (s === "default") return "builtin";
  if (s === "project") return "project";
  return "global";
}

// ─── Text rendering ─────────────────────────────────────────────────────────

function printText(eff: Effective, cwd: string, scope: InfoScope): void {
  const out = process.stdout;
  const scopeNote =
    scope === "all"
      ? "effective configuration"
      : `${scope} layer only`;

  const buildInfo = getBuildInfo();
  out.write(header(`huko info — ${scopeNote}`) + "\n");
  out.write(`version: ${emphasis(getHukoVersion())}\n`);
  if (buildInfo !== null) {
    out.write(`commit:  ${emphasis(buildInfo.commit)}\n`);
    out.write(`built:   ${emphasis(buildInfo.date)}\n`);
  } else {
    out.write(`build:   ${emphasis("dev")}\n`);
  }
  out.write(`cwd:     ${emphasis(cwd)}\n`);
  if (scope !== "all") {
    out.write(
      dim("(use `huko provider list` / `huko model list` to see all definitions)") + "\n",
    );
  }
  out.write("\n");

  // Current mode section (parallel to Current provider / Current model)
  if (eff.mode.source !== null) {
    out.write(
      bold("Current mode:    ") +
        ` ${emphasis(eff.mode.value)}   (set in: ${source(displaySource(eff.mode.source), displaySource(eff.mode.source))})\n\n`,
    );
  } else if (scope === "all") {
    // Effective view always has a mode (defaults to "full"). Show it.
    out.write(
      bold("Current mode:    ") +
        ` ${emphasis(eff.mode.value)}   ${dim("(from default)")}\n\n`,
    );
  } else {
    out.write(
      bold("Current mode:    ") +
        " " +
        yellow(`(not set in ${scope})`) +
        "\n\n",
    );
  }

  // Compaction (always shown — it's a key knob and the resolved
  // numbers depend on the active model's context window, which info
  // already prints below). Picks up `--compact=` / `--compact-threshold=`
  // explicit overrides too.
  {
    const modelWindow =
      eff.currentModel?.contextWindow ??
      (eff.currentModel
        ? estimateContextWindow(eff.currentModel.modelId)
        : 200_000);
    const resolved = resolveCompaction(getConfig().compaction, modelWindow);
    const ratios = `threshold ${(resolved.thresholdRatio * 100).toFixed(0)}% / target ${(resolved.targetRatio * 100).toFixed(0)}%`;
    out.write(
      bold("Compaction:      ") +
        ` ${emphasis(resolved.display)}   ${dim(`(${ratios})`)}\n`,
    );
    if (eff.currentModel) {
      const tokenBudget = Math.round(modelWindow * resolved.thresholdRatio);
      out.write(
        dim(
          `                  ~${tokenBudget.toLocaleString()} tokens before compaction triggers ` +
            `(of ${modelWindow.toLocaleString()} window)`,
        ) + "\n",
      );
    }
    out.write("\n");
  }

  // Other runtime overrides (always shown if any exist; section omitted
  // when empty to avoid noise on a fresh install)
  if (eff.runtimeOverrides.length > 0) {
    const heading =
      scope === "all" ? "Other runtime overrides:" : `Set by ${scope} config:`;
    out.write(header(heading) + "\n");
    const rows: Array<[string, string]> = eff.runtimeOverrides.map((o) => {
      const where =
        scope === "all"
          ? `   (set in: ${source(displaySource(o.source), displaySource(o.source))})`
          : "";
      return [o.path, `${emphasis(formatValue(o.value))}${where}`];
    });
    printDetailBlock(rows);
    out.write("\n");
  }

  // Current provider section
  if (eff.currentProvider) {
    const setIn = eff.currentProviderSource
      ? `   (set in: ${source(eff.currentProviderSource, eff.currentProviderSource)})`
      : "";
    out.write(
      bold("Current provider:") + ` ${emphasis(eff.currentProvider.name)}${setIn}\n`,
    );
    const keySrc = describeKeySource(eff.currentProvider.apiKeyRef, { cwd });
    const headers =
      eff.currentProvider.defaultHeaders &&
      Object.keys(eff.currentProvider.defaultHeaders).length > 0
        ? JSON.stringify(eff.currentProvider.defaultHeaders)
        : dim("(none)");
    const detailRows: Array<[string, string]> = [
      ["Protocol", eff.currentProvider.protocol],
      ["Base URL", emphasis(eff.currentProvider.baseUrl)],
      ["Default headers", headers],
      ["Provider definition", source(eff.currentProvider.source, eff.currentProvider.source)],
      ["API key ref", eff.currentProvider.apiKeyRef],
      [
        "Key resolves",
        keySrc.layer === "unset"
          ? yellow(
              `(unset — set ${keySrc.envName} or run \`huko keys set ${eff.currentProvider.apiKeyRef} <value>\`)`,
            )
          : `${keyStatus(keySrc.layer, keySrc.layer)}   ${dim(`(env name: ${keySrc.envName})`)}`,
      ],
    ];
    printDetailBlock(detailRows);
    out.write("\n");
  } else {
    if (eff.currentProviderSource) {
      out.write(
        bold("Current provider:") +
          " " +
          red(
            `(unresolved — pointer set in ${eff.currentProviderSource}, but no matching provider definition)`,
          ) +
          "\n\n",
      );
    } else {
      out.write(
        bold("Current provider:") +
          " " +
          yellow(scope === "all" ? "(none configured)" : `(not set in ${scope})`) +
          "\n\n",
      );
    }
  }

  // Current model section
  if (eff.currentModel) {
    const setIn = eff.currentModelSource
      ? `   (set in: ${source(eff.currentModelSource, eff.currentModelSource)})`
      : "";
    out.write(
      bold("Current model:   ") +
        ` ${emphasis(`${eff.currentModel.providerName}/${eff.currentModel.modelId}`)}${setIn}\n`,
    );
    const cwValue = eff.currentModel.contextWindow ?? estimateContextWindow(eff.currentModel.modelId);
    const cwOrigin = eff.currentModel.contextWindow !== undefined
      ? "from model definition"
      : "estimated from model id";
    const detailRows: Array<[string, string]> = [
      ["Display name", eff.currentModel.displayName],
      ["Think level", eff.currentModel.defaultThinkLevel ?? "off"],
      ["Tool call mode", eff.currentModel.defaultToolCallMode ?? "native"],
      ["Context window", `${cwValue.toLocaleString()} tokens   ${dim(`(${cwOrigin})`)}`],
      ["Model definition", source(eff.currentModel.source, eff.currentModel.source)],
    ];
    printDetailBlock(detailRows);
    out.write("\n");
  } else {
    if (eff.currentModelSource) {
      out.write(
        bold("Current model:   ") +
          " " +
          red(
            `(unresolved — pointer set in ${eff.currentModelSource}, but no matching model definition)`,
          ) +
          "\n\n",
      );
    } else {
      out.write(
        bold("Current model:   ") +
          " " +
          yellow(scope === "all" ? "(none configured)" : `(not set in ${scope})`) +
          "\n\n",
      );
    }
  }

  // Config files (only in merged view)
  if (scope === "all") {
    out.write(header("Config files:") + "\n");
    const files = collectConfigFiles(cwd);
    const rows: Array<[string, string]> = files.map((f) => {
      const ok = existsSync(f.path);
      const status = ok ? green("(exists)") : dim("(not present)");
      return [f.label, `${f.path}   ${status}`];
    });
    printDetailBlock(rows);
  }
}

/**
 * Helper: list every on-disk file `huko info` considers user state. Two
 * pairs each for providers / runtime config / keys.
 *
 * Order is "providers → runtime → keys" so layered changes are visually
 * grouped; within each pair `global` comes before `project`.
 */
function collectConfigFiles(cwd: string): Array<{ label: string; path: string }> {
  return [
    { label: "providers.json (global)", path: globalConfigPath() },
    { label: "providers.json (project)", path: projectConfigPath(cwd) },
    { label: "config.json (global)", path: runtimeGlobalPath() },
    { label: "config.json (project)", path: runtimeProjectPath(cwd) },
    { label: "keys.json (global)", path: globalKeysPath() },
    { label: "keys.json (project)", path: projectKeysPath(cwd) },
  ];
}

function runtimeGlobalPath(): string {
  return path.join(os.homedir(), ".huko", "config.json");
}

function runtimeProjectPath(cwd: string): string {
  return path.join(cwd, ".huko", "config.json");
}

/** Stringify a runtime-config leaf value for display. */
function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function printDetailBlock(rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    process.stdout.write(`  ${pad(k + ":", labelWidth + 2)} ${v}\n`);
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// ─── JSON payload ───────────────────────────────────────────────────────────

type Payload = {
  header: {
    cwd: string;
    scope: InfoScope;
    version: string;
    /** Short git SHA. `null` in dev (unbundled). */
    commit: string | null;
    /** ISO date YYYY-MM-DD. `null` in dev. */
    buildDate: string | null;
  };
  currentMode: {
    value: "lean" | "full";
    /** Layer that set the value (display label: "global" not "user"). */
    source: string | null;
  };
  runtimeOverrides: Array<{
    path: string;
    value: unknown;
    /** Layer that set the value (display label). */
    source: string;
    layerPath?: string;
  }>;
  currentProvider: {
    name: string;
    protocol: string;
    baseUrl: string;
    defaultHeaders: Record<string, string> | null;
    apiKeyRef: string;
    keyLayer: string;
    envVar: string;
    definitionSource: string;
    pointerSource: string | null;
  } | null;
  currentModel: {
    providerName: string;
    modelId: string;
    displayName: string;
    thinkLevel: string;
    toolCallMode: string;
    contextWindow: number;
    /** "model" if the model definition pinned it; "estimator" if derived from modelId. */
    contextWindowSource: "model" | "estimator";
    definitionSource: string;
    pointerSource: string | null;
  } | null;
  files: Array<{ label: string; path: string; exists: boolean }>;
};

function buildPayload(eff: Effective, cwd: string, scope: InfoScope): Payload {
  const cp = eff.currentProvider
    ? (() => {
        const keySrc = describeKeySource(eff.currentProvider!.apiKeyRef, { cwd });
        return {
          name: eff.currentProvider!.name,
          protocol: eff.currentProvider!.protocol,
          baseUrl: eff.currentProvider!.baseUrl,
          defaultHeaders: eff.currentProvider!.defaultHeaders ?? null,
          apiKeyRef: eff.currentProvider!.apiKeyRef,
          keyLayer: keySrc.layer,
          envVar: keySrc.envName,
          definitionSource: eff.currentProvider!.source,
          pointerSource: eff.currentProviderSource,
        };
      })()
    : null;

  const cm = eff.currentModel
    ? {
        providerName: eff.currentModel.providerName,
        modelId: eff.currentModel.modelId,
        displayName: eff.currentModel.displayName,
        thinkLevel: eff.currentModel.defaultThinkLevel ?? "off",
        toolCallMode: eff.currentModel.defaultToolCallMode ?? "native",
        contextWindow:
          eff.currentModel.contextWindow ?? estimateContextWindow(eff.currentModel.modelId),
        contextWindowSource:
          eff.currentModel.contextWindow !== undefined
            ? ("model" as const)
            : ("estimator" as const),
        definitionSource: eff.currentModel.source,
        pointerSource: eff.currentModelSource,
      }
    : null;

  const files =
    scope === "all"
      ? collectConfigFiles(cwd).map((f) => ({ ...f, exists: existsSync(f.path) }))
      : [];

  return {
    header: {
      cwd,
      scope,
      version: getHukoVersion(),
      commit: getBuildInfo()?.commit ?? null,
      buildDate: getBuildInfo()?.date ?? null,
    },
    currentMode: {
      value: eff.mode.value,
      source: eff.mode.source !== null ? displaySource(eff.mode.source) : null,
    },
    runtimeOverrides: eff.runtimeOverrides.map((o) => ({
      path: o.path,
      value: o.value,
      source: displaySource(o.source),
      ...(o.layerPath !== undefined ? { layerPath: o.layerPath } : {}),
    })),
    currentProvider: cp,
    currentModel: cm,
    files,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
