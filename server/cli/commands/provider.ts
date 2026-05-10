/**
 * server/cli/commands/provider.ts
 *
 * `huko provider <verb>` — manage LLM providers in the layered infra
 * config.
 *
 * Verbs:
 *   - `list`                     show merged provider view + source layer
 *   - `add <flags>`              write a provider to global (or --project)
 *   - `remove <name> [--project]` remove from the chosen layer; for
 *                                 built-ins, append to that layer's
 *                                 `disabledProviders` (built-ins can't
 *                                 be deleted, only vetoed).
 *
 * Storage:
 *   - global  → ~/.huko/providers.json
 *   - project → <cwd>/.huko/providers.json   (commit-friendly)
 *
 * The CLI never sees numeric ids — providers are identified by `name`.
 *
 * Exit codes:
 *   0 ok    1 internal error    3 usage error    4 not found
 */

import { describeKeySource } from "../../security/keys.js";
import { bold, dim, keyStatus, padVisible, source } from "../colors.js";
import {
  loadInfraConfig,
  readGlobalConfigFile,
  readProjectConfigFile,
  writeGlobalConfigFile,
  writeProjectConfigFile,
  type InfraConfigFile,
  type ProviderConfig,
  type ResolvedProvider,
} from "../../config/index.js";
import { BUILTIN_PROVIDERS } from "../../config/builtin-providers.js";

export type OutputFormat = "text" | "jsonl" | "json";

export type ProviderListArgs = { format: OutputFormat };

export type ProviderAddArgs = {
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKeyRef: string;
  defaultHeaders?: Record<string, string>;
  /** When true, write to <cwd>/.huko/providers.json instead of global. */
  project?: boolean;
};

export type ProviderRemoveArgs = {
  name: string;
  /** When true, remove from <cwd>/.huko/providers.json instead of global. */
  project?: boolean;
};

export type ProviderCurrentArgs = {
  /** Omit to read; provide to write. */
  name?: string;
  /** When true, write to <cwd>/.huko/providers.json instead of global. */
  project?: boolean;
};

// ─── list ────────────────────────────────────────────────────────────────────

export async function providerListCommand(args: ProviderListArgs): Promise<number> {
  try {
    const cfg = loadInfraConfig({ cwd: process.cwd() });
    const sorted = [...cfg.providers].sort((a, b) => a.name.localeCompare(b.name));

    switch (args.format) {
      case "json":
        process.stdout.write(
          JSON.stringify(sorted.map(serialise), null, 2) + "\n",
        );
        break;
      case "jsonl":
        for (const p of sorted) {
          process.stdout.write(JSON.stringify(serialise(p)) + "\n");
        }
        break;
      case "text":
      default:
        printTable(sorted);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider list failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

export async function providerAddCommand(args: ProviderAddArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next: InfraConfigFile = { ...file };
    next.providers = [...(file.providers ?? [])];

    // Replace any existing entry of the same name in this layer.
    const idx = next.providers.findIndex((p) => p.name === args.name);
    const provider: ProviderConfig = {
      name: args.name,
      protocol: args.protocol,
      baseUrl: args.baseUrl,
      apiKeyRef: args.apiKeyRef,
      ...(args.defaultHeaders !== undefined ? { defaultHeaders: args.defaultHeaders } : {}),
    };
    if (idx >= 0) {
      next.providers[idx] = provider;
    } else {
      next.providers.push(provider);
    }

    // If the name is on this layer's disabledProviders list, dropping it
    // is the user's likely intent — re-adding overrides the veto.
    if (next.disabledProviders) {
      next.disabledProviders = next.disabledProviders.filter((n) => n !== args.name);
      if (next.disabledProviders.length === 0) delete next.disabledProviders;
    }

    if (args.project) {
      writeProjectConfigFile(cwd, next);
    } else {
      writeGlobalConfigFile(next);
    }

    const src = describeKeySource(args.apiKeyRef, { cwd });
    const layerNote =
      src.layer === "unset"
        ? `WARNING: api key ref "${args.apiKeyRef}" is NOT yet resolvable. ` +
          `Set ${src.envName} in env, run \`huko keys set ${args.apiKeyRef} <value>\`, ` +
          `or add it to <cwd>/.env.`
        : `key ref "${args.apiKeyRef}" resolves from: ${src.layer}`;

    process.stderr.write(
      `huko: ${idx >= 0 ? "updated" : "added"} provider "${args.name}" (${args.protocol}) in ${layerName} config\n` +
        `      ${layerNote}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider add failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── remove ──────────────────────────────────────────────────────────────────

export async function providerRemoveCommand(args: ProviderRemoveArgs): Promise<number> {
  try {
    const cwd = process.cwd();
    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next: InfraConfigFile = { ...file };

    const isBuiltin = BUILTIN_PROVIDERS.some((p) => p.name === args.name);
    const inThisLayer = (file.providers ?? []).some((p) => p.name === args.name);

    if (!isBuiltin && !inThisLayer) {
      // Could exist in the OTHER layer — check for a useful hint.
      const cfg = loadInfraConfig({ cwd });
      const other = cfg.providers.find((p) => p.name === args.name);
      if (other) {
        process.stderr.write(
          `huko: provider "${args.name}" not found in ${layerName} config ` +
            `(it lives in ${other.source} — re-run with ${other.source === "project" ? "--project" : "(no flag)"} or edit that file directly)\n`,
        );
      } else {
        process.stderr.write(`huko: provider "${args.name}" not found\n`);
      }
      return 4;
    }

    if (inThisLayer) {
      next.providers = (file.providers ?? []).filter((p) => p.name !== args.name);
      if (next.providers.length === 0) delete next.providers;
    }

    if (isBuiltin) {
      // Built-ins can't be deleted (they're hard-coded in huko); veto by
      // adding to disabledProviders. If the user just wanted to override
      // the built-in, they should `provider add` instead.
      const disabled = new Set(next.disabledProviders ?? []);
      disabled.add(args.name);
      next.disabledProviders = [...disabled];
    }

    if (args.project) {
      writeProjectConfigFile(cwd, next);
    } else {
      writeGlobalConfigFile(next);
    }

    const action = isBuiltin
      ? inThisLayer
        ? "removed local override and disabled built-in"
        : "disabled built-in"
      : "removed";
    process.stderr.write(`huko: ${action} provider "${args.name}" in ${layerName} config\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider remove failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── current ─────────────────────────────────────────────────────────────────

export async function providerCurrentCommand(args: ProviderCurrentArgs): Promise<number> {
  try {
    const cwd = process.cwd();

    if (args.name === undefined) {
      // Read mode — show the merged current provider.
      const cfg = loadInfraConfig({ cwd });
      if (!cfg.currentProvider) {
        process.stdout.write("(none)\n");
        return 0;
      }
      process.stdout.write(
        `${cfg.currentProvider.name}  (set in: ${cfg.currentProviderSource ?? "—"})\n`,
      );
      return 0;
    }

    // Write mode — sanity-check the provider exists in the merged set.
    const cfg = loadInfraConfig({ cwd });
    if (!cfg.providers.some((p) => p.name === args.name)) {
      process.stderr.write(
        `huko: provider not found: ${args.name}\n` +
          `      run \`huko provider list\` to see available providers\n`,
      );
      return 4;
    }

    const layerName = args.project ? "project" : "global";
    const file = args.project ? readProjectConfigFile(cwd) : readGlobalConfigFile();
    const next = { ...file, currentProvider: args.name };
    if (args.project) writeProjectConfigFile(cwd, next);
    else writeGlobalConfigFile(next);

    // Friendly nudge: if the now-current provider doesn't own the
    // currentModel, the pair is broken until the user picks a model.
    const layerModel = next.currentModel ?? cfg.currentModel?.modelId;
    const pairOk = layerModel
      ? cfg.models.some((m) => m.providerName === args.name && m.modelId === layerModel)
      : false;
    process.stderr.write(
      `huko: current provider -> ${args.name} in ${layerName} config\n` +
        (pairOk
          ? ""
          : `      WARNING: current model ${layerModel ?? "(none)"} doesn't exist for ${args.name}.\n` +
            `      Pick one with: huko model current <modelId>\n`),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`huko: provider current failed: ${describe(err)}\n`);
    return 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serialise(p: ResolvedProvider): {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyRef: string;
  defaultHeaders: Record<string, string> | null;
  source: string;
  keyLayer: string;
} {
  const src = describeKeySource(p.apiKeyRef, { cwd: process.cwd() });
  return {
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKeyRef: p.apiKeyRef,
    defaultHeaders: p.defaultHeaders ?? null,
    source: p.source,
    keyLayer: src.layer,
  };
}

function printTable(rows: ResolvedProvider[]): void {
  if (rows.length === 0) {
    process.stdout.write(dim("(no providers)") + "\n");
    return;
  }

  const cwd = process.cwd();
  const headerCells = ["NAME", "PROTOCOL", "BASE URL", "KEY REF", "KEY", "SOURCE"];
  // Two parallel arrays: raw (for width math) and styled (for output).
  const raw: string[][] = [];
  const styled: string[][] = [];
  for (const p of rows) {
    const src = describeKeySource(p.apiKeyRef, { cwd });
    const keyLabel = src.layer === "unset" ? "(unset)" : src.layer;
    raw.push([p.name, p.protocol, p.baseUrl, p.apiKeyRef, keyLabel, p.source]);
    styled.push([
      p.name,
      p.protocol,
      p.baseUrl,
      p.apiKeyRef,
      keyStatus(keyLabel, src.layer),
      source(p.source, p.source),
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
