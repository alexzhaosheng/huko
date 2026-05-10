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
 *   - `huko info builtin`   what huko ships with.
 *
 * Provider/model LISTS aren't shown here — `huko provider list` and
 * `huko model list` already cover those. `info` is the focused view:
 * "what's actually going to run if I type `huko run`".
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
import {
  loadInfraConfig,
  type ConfigSource,
  type InfraConfig,
  type ResolvedModel,
  type ResolvedProvider,
} from "../../config/index.js";
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
  BUILTIN_CURRENT_MODEL,
  BUILTIN_CURRENT_PROVIDER,
} from "../../config/builtin-providers.js";
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

export type InfoScope = "all" | "global" | "project" | "builtin";

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
 *   - `builtin` → the hard-coded BUILTIN_CURRENT_*.
 *
 * In each case we still resolve the names against the FULL merged
 * provider/model set so the user sees full details (URL, protocol,
 * etc.) even when the entity definition lives in a different layer.
 */
function effectiveForScope(cfg: InfraConfig, scope: InfoScope, cwd: string): Effective {
  if (scope === "all") {
    return {
      currentProvider: cfg.currentProvider,
      currentProviderSource: cfg.currentProviderSource,
      currentModel: cfg.currentModel,
      currentModelSource: cfg.currentModelSource,
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
  } else if (scope === "project") {
    layer = "project";
    const file = readProjectConfigFile(cwd);
    providerName = file.currentProvider;
    modelId = file.currentModel;
  } else {
    layer = "builtin";
    providerName = BUILTIN_CURRENT_PROVIDER;
    modelId = BUILTIN_CURRENT_MODEL;
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
  };
}

// ─── Text rendering ─────────────────────────────────────────────────────────

function printText(eff: Effective, cwd: string, scope: InfoScope): void {
  const out = process.stdout;
  const scopeNote =
    scope === "all"
      ? "effective configuration"
      : `${scope} layer only`;

  out.write(header(`huko info — ${scopeNote}`) + "\n");
  out.write(`cwd: ${emphasis(cwd)}\n`);
  if (scope !== "all") {
    out.write(
      dim("(use `huko provider list` / `huko model list` to see all definitions)") + "\n",
    );
  }
  out.write("\n");

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
    const detailRows: Array<[string, string]> = [
      ["Display name", eff.currentModel.displayName],
      ["Think level", eff.currentModel.defaultThinkLevel ?? "off"],
      ["Tool call mode", eff.currentModel.defaultToolCallMode ?? "native"],
      ["Model definition", source(eff.currentModel.source, eff.currentModel.source)],
    ];
    if (eff.currentModel.contextWindow !== undefined) {
      detailRows.push(["Context window", String(eff.currentModel.contextWindow)]);
    }
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
    const files = [
      { label: "providers.json (global)", path: globalConfigPath() },
      { label: "providers.json (project)", path: projectConfigPath(cwd) },
      { label: "keys.json (global)", path: globalKeysPath() },
      { label: "keys.json (project)", path: projectKeysPath(cwd) },
    ];
    const rows: Array<[string, string]> = files.map((f) => {
      const ok = existsSync(f.path);
      const status = ok ? green("(exists)") : dim("(not present)");
      return [f.label, `${f.path}   ${status}`];
    });
    printDetailBlock(rows);
  }
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
  header: { cwd: string; scope: InfoScope };
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
    contextWindow?: number;
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
        ...(eff.currentModel.contextWindow !== undefined
          ? { contextWindow: eff.currentModel.contextWindow }
          : {}),
        definitionSource: eff.currentModel.source,
        pointerSource: eff.currentModelSource,
      }
    : null;

  const files =
    scope === "all"
      ? [
          { label: "providers.json (global)", path: globalConfigPath() },
          { label: "providers.json (project)", path: projectConfigPath(cwd) },
          { label: "keys.json (global)", path: globalKeysPath() },
          { label: "keys.json (project)", path: projectKeysPath(cwd) },
        ].map((f) => ({ ...f, exists: existsSync(f.path) }))
      : [];

  return {
    header: { cwd, scope },
    currentProvider: cp,
    currentModel: cm,
    files,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
