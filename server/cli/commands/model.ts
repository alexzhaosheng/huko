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
    source: m.source,
    isDefault: ref === defaultRef,
  };
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

  const headerCells = ["PROVIDER", "MODEL ID", "DISPLAY", "THINK", "TOOL", "SOURCE", "CURRENT"];
  const raw: string[][] = [];
  const styled: string[][] = [];
  for (const m of rows) {
    const ref = `${m.providerName}/${m.modelId}`;
    const isCurrent = ref === defaultRef;
    raw.push([
      m.providerName, m.modelId, m.displayName,
      m.defaultThinkLevel ?? "off", m.defaultToolCallMode ?? "native",
      m.source, isCurrent ? "*" : "",
    ]);
    styled.push([
      m.providerName,
      m.modelId,
      m.displayName,
      m.defaultThinkLevel ?? "off",
      m.defaultToolCallMode ?? "native",
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

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
