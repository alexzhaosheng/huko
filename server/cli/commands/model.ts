/**
 * server/cli/commands/model.ts
 *
 * `huko model <verb>` — manage model definitions in the layered infra
 * config.
 *
 * Verbs:
 *   - `list`                  show merged model view + source layer
 *   - `add <flags>`           write a model to global (or --project)
 *   - `remove <ref> [--project]`  remove from chosen layer; for built-ins,
 *                                 add to that layer's `disabledModels` veto.
 *   - `default [<ref>]`       show or set the default model. <ref> is
 *                             `<providerName>/<modelId>` or
 *                             `<providerName>:<modelId>` — `/` is allowed
 *                             inside <modelId> (e.g. `openrouter/anthropic/claude-sonnet-4.5`).
 *
 * Identifier: composite `(providerName, modelId)`. No numeric ids.
 *
 * Exit codes:
 *   0 ok    1 internal error    3 usage error    4 not found
 */

import {
  loadInfraConfig,
  readGlobalConfigFile,
  readProjectConfigFile,
  writeGlobalConfigFile,
  writeProjectConfigFile,
  type InfraConfigFile,
  type ModelConfig,
  type ResolvedModel,
} from "../../config/index.js";
import { BUILTIN_MODELS } from "../../config/builtin-providers.js";
import { estimateContextWindow } from "../../core/llm/model-context-window.js";
import type { ThinkLevel, ToolCallMode } from "../../core/llm/types.js";
import { bold, cyan, dim, padVisible, source } from "../colors.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type ModelListArgs = { format: OutputFormat };

export type ModelAddArgs = {
  /** Provider name (must already exist as a provider). */
  provider: string;
  modelId: string;
  displayName?: string;
  thinkLevel?: ThinkLevel;
  toolCallMode?: ToolCallMode;
  /**
   * Per-model context-window override (in tokens). Overrides the
   * heuristic table in `core/llm/model-context-window.ts`. Tied to the
   * model so changing model = changing window.
   */
  contextWindow?: number;
  /** When true, also set this model as default. */
  setCurrent?: boolean;
  /** When true, write to <cwd>/.huko/providers.json instead of global. */
  project?: boolean;
};

export type ModelRemoveArgs = {
  ref: string;
  project?: boolean;
};

export type ModelCurrentArgs = {
  modelId?: string;
  project?: boolean;
};

export type ModelShowArgs = {
  ref: string;
  format: OutputFormat;
};

/**
 * Patch flags for `huko model update`. Every field is optional — only
 * the ones passed on the CLI are touched. `--context-window=auto` lands
 * here as `contextWindow: "auto"` so the writer can DELETE the field
 * (revert to heuristic) instead of conflating with "leave unchanged".
 */
export type ModelUpdateArgs = {
  ref: string;
  project?: boolean;
  displayName?: string;
  thinkLevel?: ThinkLevel;
  toolCallMode?: ToolCallMode;
  contextWindow?: number | "auto";
};

// ─── list ────────────────────────────────────────────────────────────────────

export async function modelListCommand(args: ModelListArgs): Promise<number> {
  try {
    const cfg = loadInfraConfig({ cwd: process.cwd() });
    const sorted = [...cfg.models].sort((a, b) => {
      const byProv = a.providerName.localeCompare(b.providerName);
      return byProv !== 0 ? byProv : a.modelId.localeCompare(b.modelId);
    });
    const defaultRef = cfg.currentModel
      ? `${cfg.currentModel.providerName}/${cfg.currentModel.modelId}`
      : null;

    switch (args.format) {
      case "json":
        process.stdout.write(
          JSON.stringify(sorted.map((m) => serialise(m, defaultRef)), null, 2) + "\n",
        );
        break;
      case "jsonl":
        for (const m of sorted) {
          process.stdout.write(JSON.stringify(serialise(m, defaultRef)) + "\n");
        }
        break;
      case "text":
      default:
        printTable(sorted, defaultRef);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model list failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

export async function modelAddCommand(args: ModelAddArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const cfg = loadInfraConfig({ cwd });

    // Sanity: provider must exist (in any layer) before we can add a
    // model to it. Otherwise the model would be orphaned and dropped
    // silently from the merged view.
    if (!cfg.providers.some((p) => p.name === args.provider)) {
      process.stderr.write(
        `huko: provider not found: ${args.provider}\n` +
          `      run \`huko provider list\` to see available providers\n`,
      );
      return 4;
    }

    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next: InfraConfigFile = { ...file };
    next.models = [...(file.models ?? [])];

    // Replace existing entry with the same composite key.
    const idx = next.models.findIndex(
      (m) => m.providerName === args.provider && m.modelId === args.modelId,
    );
    const model: ModelConfig = {
      providerName: args.provider,
      modelId: args.modelId,
      displayName: args.displayName ?? args.modelId,
      ...(args.thinkLevel !== undefined ? { defaultThinkLevel: args.thinkLevel } : {}),
      ...(args.toolCallMode !== undefined ? { defaultToolCallMode: args.toolCallMode } : {}),
      ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
    };
    if (idx >= 0) {
      next.models[idx] = model;
    } else {
      next.models.push(model);
    }

    // If this model was previously vetoed in this layer, re-enable it.
    if (next.disabledModels) {
      next.disabledModels = next.disabledModels.filter(
        (m) => !(m.providerName === args.provider && m.modelId === args.modelId),
      );
      if (next.disabledModels.length === 0) delete next.disabledModels;
    }

    if (args.setCurrent) {
      next.currentProvider = args.provider;
      next.currentModel = args.modelId;
    }

    if (args.project) writeProjectConfigFile(cwd, next);
    else writeGlobalConfigFile(next);

    process.stderr.write(
      `huko: ${idx >= 0 ? "updated" : "added"} model "${args.provider}/${args.modelId}" in ${layerName} config` +
        (args.setCurrent ? " (set as current)" : "") +
        "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model add failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── remove ──────────────────────────────────────────────────────────────────

export async function modelRemoveCommand(args: ModelRemoveArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const parsed = parseRef(args.ref);
    if (!parsed) {
      process.stderr.write(
        `huko: invalid model ref: ${args.ref}\n` +
          `      expected <providerName>/<modelId>, e.g. anthropic/claude-sonnet-4-6\n`,
      );
      return 3;
    }

    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next: InfraConfigFile = { ...file };

    const isBuiltin = BUILTIN_MODELS.some(
      (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
    );
    const inThisLayer = (file.models ?? []).some(
      (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
    );

    if (!isBuiltin && !inThisLayer) {
      const cfg = loadInfraConfig({ cwd });
      const other = cfg.models.find(
        (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
      );
      if (other) {
        process.stderr.write(
          `huko: model "${args.ref}" not found in ${layerName} config ` +
            `(it lives in ${other.source} — re-run with ${other.source === "project" ? "--project" : "(no flag)"} or edit that file directly)\n`,
        );
      } else {
        process.stderr.write(`huko: model "${args.ref}" not found\n`);
      }
      return 4;
    }

    if (inThisLayer) {
      next.models = (file.models ?? []).filter(
        (m) => !(m.providerName === parsed.providerName && m.modelId === parsed.modelId),
      );
      if (next.models.length === 0) delete next.models;
    }

    if (isBuiltin) {
      next.disabledModels = [
        ...(next.disabledModels ?? []),
        { providerName: parsed.providerName, modelId: parsed.modelId },
      ];
    }

    // If this layer's current pointers reference the removed model,
    // clear them so the user knows to re-pick.
    if (
      next.currentProvider === parsed.providerName &&
      next.currentModel === parsed.modelId
    ) {
      delete next.currentProvider;
      delete next.currentModel;
    }

    if (args.project) writeProjectConfigFile(cwd, next);
    else writeGlobalConfigFile(next);

    const action = isBuiltin
      ? inThisLayer
        ? "removed local override and disabled built-in"
        : "disabled built-in"
      : "removed";
    process.stderr.write(`huko: ${action} model "${args.ref}" in ${layerName} config\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model remove failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── current ─────────────────────────────────────────────────────────────────

export async function modelCurrentCommand(args: ModelCurrentArgs): Promise<number> {
  try {
    const cwd = process.cwd();

    if (args.modelId === undefined) {
      // Read mode — show the merged current model + provider.
      const cfg = loadInfraConfig({ cwd });
      if (!cfg.currentModel) {
        if (cfg.currentProvider) {
          process.stdout.write(
            `(no model — current provider is ${cfg.currentProvider.name}, set a model with \`huko model current <modelId>\`)\n`,
          );
        } else {
          process.stdout.write("(none)\n");
        }
        return 0;
      }
      const m = cfg.currentModel;
      process.stdout.write(
        `${m.providerName}/${m.modelId}  "${m.displayName}" (set in: ${cfg.currentModelSource ?? "—"})\n`,
      );
      return 0;
    }

    // Write mode — modelId is paired with the active currentProvider.
    // We resolve currentProvider from the SAME layer we're writing to,
    // falling back to the merged value if that layer hasn't pinned one.
    const cfg = loadInfraConfig({ cwd });
    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const layerProvider = file.currentProvider ?? cfg.currentProvider?.name;
    if (!layerProvider) {
      process.stderr.write(
        `huko: no current provider set; run \`huko provider current <name>\` first\n`,
      );
      return 3;
    }
    const target = cfg.models.find(
      (m) => m.providerName === layerProvider && m.modelId === args.modelId,
    );
    if (!target) {
      process.stderr.write(
        `huko: model not found: ${layerProvider}/${args.modelId}\n` +
          `      run \`huko model list\` to see available models for "${layerProvider}"\n`,
      );
      return 4;
    }

    const next: InfraConfigFile = { ...file, currentModel: args.modelId };
    if (args.project) writeProjectConfigFile(cwd, next);
    else writeGlobalConfigFile(next);

    process.stderr.write(
      `huko: current model -> ${layerProvider}/${args.modelId} ("${target.displayName}") in ${layerName} config\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model current failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── show ────────────────────────────────────────────────────────────────────

export async function modelShowCommand(args: ModelShowArgs): Promise<number> {
  try {
    const parsed = parseRef(args.ref);
    if (!parsed) {
      process.stderr.write(
        `huko: invalid model ref: ${args.ref}\n` +
          `      expected <providerName>/<modelId>, e.g. anthropic/claude-sonnet-4-6\n`,
      );
      return 3;
    }

    const cfg = loadInfraConfig({ cwd: process.cwd() });
    const model = cfg.models.find(
      (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
    );
    if (!model) {
      process.stderr.write(`huko: model "${args.ref}" not found\n`);
      return 4;
    }

    const defaultRef = cfg.currentModel
      ? `${cfg.currentModel.providerName}/${cfg.currentModel.modelId}`
      : null;
    const isCurrent = `${model.providerName}/${model.modelId}` === defaultRef;
    const effectiveCtx = model.contextWindow ?? estimateContextWindow(model.modelId);
    const ctxSource: "config" | "heuristic" =
      model.contextWindow !== undefined ? "config" : "heuristic";

    switch (args.format) {
      case "json":
        process.stdout.write(
          JSON.stringify(showPayload(model, isCurrent, effectiveCtx, ctxSource), null, 2) + "\n",
        );
        break;
      case "jsonl":
        process.stdout.write(
          JSON.stringify(showPayload(model, isCurrent, effectiveCtx, ctxSource)) + "\n",
        );
        break;
      case "text":
      default:
        printShowCard(model, isCurrent, effectiveCtx, ctxSource);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model show failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── update ──────────────────────────────────────────────────────────────────

export async function modelUpdateCommand(args: ModelUpdateArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const parsed = parseRef(args.ref);
    if (!parsed) {
      process.stderr.write(
        `huko: invalid model ref: ${args.ref}\n` +
          `      expected <providerName>/<modelId>, e.g. anthropic/claude-sonnet-4-6\n`,
      );
      return 3;
    }

    // Nothing to patch? Tell the user instead of silently rewriting the
    // file to an identical state.
    if (
      args.displayName === undefined &&
      args.thinkLevel === undefined &&
      args.toolCallMode === undefined &&
      args.contextWindow === undefined
    ) {
      process.stderr.write(
        `huko: model update: nothing to change — pass at least one of ` +
          `--display-name / --think-level / --tool-call-mode / --context-window\n`,
      );
      return 3;
    }

    const cfg = loadInfraConfig({ cwd });
    const existing = cfg.models.find(
      (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
    );
    if (!existing) {
      process.stderr.write(
        `huko: model "${args.ref}" not found\n` +
          `      run \`huko model list\` to see available models\n`,
      );
      return 4;
    }

    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next: InfraConfigFile = { ...file };
    next.models = [...(file.models ?? [])];

    // Seed the layer entry from whatever's currently in effect (built-in
    // / lower layer / same layer — all OK; we keep the existing fields
    // and overlay the patches). This means `update` on a built-in
    // creates an override in the chosen layer instead of erroring.
    const idx = next.models.findIndex(
      (m) => m.providerName === parsed.providerName && m.modelId === parsed.modelId,
    );
    const base: ModelConfig =
      idx >= 0
        ? next.models[idx]!
        : {
            providerName: existing.providerName,
            modelId: existing.modelId,
            displayName: existing.displayName,
            ...(existing.defaultThinkLevel !== undefined
              ? { defaultThinkLevel: existing.defaultThinkLevel }
              : {}),
            ...(existing.defaultToolCallMode !== undefined
              ? { defaultToolCallMode: existing.defaultToolCallMode }
              : {}),
            ...(existing.contextWindow !== undefined
              ? { contextWindow: existing.contextWindow }
              : {}),
          };

    // Apply the patches. `undefined` means "leave alone"; the special
    // "auto" sentinel on contextWindow means "remove the override".
    const patched: ModelConfig = {
      providerName: base.providerName,
      modelId: base.modelId,
      displayName: args.displayName ?? base.displayName,
      ...(args.thinkLevel !== undefined
        ? { defaultThinkLevel: args.thinkLevel }
        : base.defaultThinkLevel !== undefined
          ? { defaultThinkLevel: base.defaultThinkLevel }
          : {}),
      ...(args.toolCallMode !== undefined
        ? { defaultToolCallMode: args.toolCallMode }
        : base.defaultToolCallMode !== undefined
          ? { defaultToolCallMode: base.defaultToolCallMode }
          : {}),
      ...(args.contextWindow === "auto"
        ? {} // explicit unset
        : args.contextWindow !== undefined
          ? { contextWindow: args.contextWindow }
          : base.contextWindow !== undefined
            ? { contextWindow: base.contextWindow }
            : {}),
    };

    if (idx >= 0) {
      next.models[idx] = patched;
    } else {
      next.models.push(patched);
    }

    // If this model was previously vetoed in this layer (someone ran
    // `huko model remove` against a built-in), re-enable it implicitly —
    // updating a model = wanting to use it.
    if (next.disabledModels) {
      next.disabledModels = next.disabledModels.filter(
        (m) => !(m.providerName === parsed.providerName && m.modelId === parsed.modelId),
      );
      if (next.disabledModels.length === 0) delete next.disabledModels;
    }

    if (args.project) writeProjectConfigFile(cwd, next);
    else writeGlobalConfigFile(next);

    const changed = describeUpdatePatch(args);
    process.stderr.write(
      `huko: updated model "${args.ref}" in ${layerName} config (${changed})\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: model update failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a model ref like `anthropic/claude-sonnet-4-6` or
 * `openrouter/anthropic/claude-sonnet-4.5`. The first `/` separates
 * provider from modelId; everything after the first `/` is the modelId
 * (so OpenRouter slugs containing `/` work). A `:` separator is also
 * accepted for convenience.
 */
function parseRef(ref: string): { providerName: string; modelId: string } | null {
  const idx = ref.indexOf("/");
  const idxColon = ref.indexOf(":");
  let sep: number;
  if (idx === -1 && idxColon === -1) return null;
  else if (idx === -1) sep = idxColon;
  else if (idxColon === -1) sep = idx;
  else sep = Math.min(idx, idxColon);
  const providerName = ref.slice(0, sep);
  const modelId = ref.slice(sep + 1);
  if (!providerName || !modelId) return null;
  return { providerName, modelId };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serialise(m: ResolvedModel, defaultRef: string | null): {
  providerName: string;
  modelId: string;
  displayName: string;
  thinkLevel: string;
  toolCallMode: string;
  contextWindow: number | null;
  source: string;
  isDefault: boolean;
} {
  const ref = `${m.providerName}/${m.modelId}`;
  return {
    providerName: m.providerName,
    modelId: m.modelId,
    displayName: m.displayName,
    thinkLevel: m.defaultThinkLevel ?? "off",
    toolCallMode: m.defaultToolCallMode ?? "native",
    contextWindow: m.contextWindow ?? null,
    source: m.source,
    isDefault: ref === defaultRef,
  };
}

/**
 * Format a context-window number as a compact human-readable string
 * (e.g. 200000 -> "200k", 1000000 -> "1m"). Empty when no override is
 * set on the model — the heuristic estimator owns that case and it'd
 * be misleading to print a number that's not authoritative.
 */
function fmtCtx(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Machine-readable single-model payload — same fields as the table
 * row plus the provider sub-record + the resolved context-window value
 * and where it came from (config vs heuristic). Stable shape; safe for
 * tooling to depend on.
 */
function showPayload(
  m: ResolvedModel,
  isCurrent: boolean,
  effectiveCtx: number,
  ctxSource: "config" | "heuristic",
): {
  ref: string;
  providerName: string;
  modelId: string;
  displayName: string;
  thinkLevel: string;
  toolCallMode: string;
  contextWindow: number;
  contextWindowOverride: number | null;
  contextWindowSource: "config" | "heuristic";
  source: string;
  isCurrent: boolean;
  provider: {
    name: string;
    baseUrl: string;
    protocol: string;
    apiKeyRef: string;
    source: string;
  };
} {
  return {
    ref: `${m.providerName}/${m.modelId}`,
    providerName: m.providerName,
    modelId: m.modelId,
    displayName: m.displayName,
    thinkLevel: m.defaultThinkLevel ?? "off",
    toolCallMode: m.defaultToolCallMode ?? "native",
    contextWindow: effectiveCtx,
    contextWindowOverride: m.contextWindow ?? null,
    contextWindowSource: ctxSource,
    source: m.source,
    isCurrent,
    provider: {
      name: m.provider.name,
      baseUrl: m.provider.baseUrl,
      protocol: m.provider.protocol,
      apiKeyRef: m.provider.apiKeyRef,
      source: m.provider.source,
    },
  };
}

function printShowCard(
  m: ResolvedModel,
  isCurrent: boolean,
  effectiveCtx: number,
  ctxSource: "config" | "heuristic",
): void {
  const ref = `${m.providerName}/${m.modelId}`;
  const header =
    bold(ref) + (isCurrent ? "  " + cyan("[current]") : "");
  const ctxLine = `${fmtCtx(effectiveCtx)} (${effectiveCtx.toLocaleString("en-US")})` +
    (ctxSource === "heuristic"
      ? "  " + dim("(from heuristic — pin with `huko model update " + ref + " --context-window=<n>`)")
      : "  " + dim("(pinned in " + m.source + " config)"));

  const lines: string[] = [];
  lines.push(header);
  lines.push(kv("display name",   m.displayName));
  lines.push(kv("source",         source(m.source, m.source)));
  lines.push(kv("think level",    m.defaultThinkLevel ?? "off"));
  lines.push(kv("tool call mode", m.defaultToolCallMode ?? "native"));
  lines.push(kv("context window", ctxLine));
  lines.push(dim("  provider"));
  lines.push(kv("  name",         m.provider.name, /*indent*/ true));
  lines.push(kv("  base url",     m.provider.baseUrl, true));
  lines.push(kv("  protocol",     m.provider.protocol, true));
  lines.push(kv("  api key ref",  m.provider.apiKeyRef, true));
  lines.push(kv("  source",       source(m.provider.source, m.provider.source), true));
  process.stdout.write(lines.join("\n") + "\n");
}

function kv(label: string, value: string, _indent = false): string {
  // Two-column "  label    value" — keep widths consistent across rows.
  // Width 18 fits all labels we emit (longest: "  tool call mode" = 16).
  const padded = padVisible(label, 18);
  return "  " + dim(padded) + value;
}

/**
 * Human-readable diff summary for the success line of `model update`.
 * Just the field names that changed, comma-separated; details would
 * duplicate what the operator just typed.
 */
function describeUpdatePatch(args: ModelUpdateArgs): string {
  const parts: string[] = [];
  if (args.displayName !== undefined) parts.push(`displayName="${args.displayName}"`);
  if (args.thinkLevel !== undefined) parts.push(`thinkLevel=${args.thinkLevel}`);
  if (args.toolCallMode !== undefined) parts.push(`toolCallMode=${args.toolCallMode}`);
  if (args.contextWindow !== undefined) {
    parts.push(
      args.contextWindow === "auto"
        ? "contextWindow=auto (cleared)"
        : `contextWindow=${args.contextWindow}`,
    );
  }
  return parts.join(", ");
}

function printTable(rows: ResolvedModel[], defaultRef: string | null): void {
  if (rows.length === 0) {
    process.stdout.write(
      dim("(no models)") + "\n" +
        dim("  the built-in set is empty in this layout — add one with `huko model add --provider=... --model-id=...`") +
        "\n",
    );
    return;
  }

  const headerCells = ["PROVIDER", "MODEL ID", "DISPLAY", "THINK", "TOOL", "CTX", "SOURCE", "CURRENT"];
  const raw: string[][] = [];
  const styled: string[][] = [];
  for (const m of rows) {
    const ref = `${m.providerName}/${m.modelId}`;
    const isCurrent = ref === defaultRef;
    const ctx = fmtCtx(m.contextWindow);
    raw.push([
      m.providerName, m.modelId, m.displayName,
      m.defaultThinkLevel ?? "off", m.defaultToolCallMode ?? "native",
      ctx,
      m.source, isCurrent ? "*" : "",
    ]);
    styled.push([
      m.providerName,
      m.modelId,
      m.displayName,
      m.defaultThinkLevel ?? "off",
      m.defaultToolCallMode ?? "native",
      ctx === "" ? dim("—") : ctx,
      source(m.source, m.source),
      isCurrent ? cyan("*") : "",
    ]);
  }

  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...raw.map((row) => row[i]!.length)),
  );

  const sep = "  ";
  const lines: string[] = [];
  lines.push(headerCells.map((h, i) => bold(padVisible(h, widths[i]!))).join(sep));
  lines.push(dim(widths.map((w) => "─".repeat(w)).join(sep)));
  for (const row of styled) {
    lines.push(row.map((cell, i) => padVisible(cell, widths[i]!)).join(sep));
  }
  process.stdout.write(lines.join("\n") + "\n");
}
