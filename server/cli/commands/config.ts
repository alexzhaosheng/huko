/**
 * server/cli/commands/config.ts
 *
 * Verbs:
 *   - `huko config show`                              — full layered dump
 *   - `huko config get <path>`                        — one value + source layer
 *   - `huko config set <path> <value> [scope]`        — write into a layer
 *   - `huko config unset <path> [scope]`              — remove from a layer
 *
 * Scope flags shared by set/unset:
 *   --global   → ~/.huko/config.json (default if neither flag is given)
 *   --project  → <cwd>/.huko/config.json
 *
 * Paths are dot-separated identifiers ("task.maxIterations"). The path
 * must exist in `DEFAULT_CONFIG` (typos rejected up front), and the
 * supplied value's type must match. A small enum whitelist
 * (`mode`, `cli.format`, ...) is checked here too — see
 * server/config/writer.ts for the schema-inference logic.
 *
 * Returns `Promise<number>` (exit code); the single `process.exit()`
 * site lives in `cli/index.ts`.
 */

import {
  type ConfigScope,
  getConfig,
  getConfigLayers,
  getValueByPath,
  inferPathSchema,
  loadConfig,
  parsePath,
  setConfigValue,
  unsetConfigValue,
} from "../../config/index.js";

export async function configShowCommand(): Promise<number> {
  try {
    loadConfig({ cwd: process.cwd() });

    const resolved = getConfig();
    const layers = getConfigLayers();

    process.stdout.write("=== Resolved config ===\n");
    process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
    process.stdout.write("\n=== Layers (low → high priority) ===\n");
    for (const layer of layers) {
      const where = layer.path ? ` (${layer.path})` : "";
      process.stdout.write(`\n[${layer.source}]${where}\n`);
      process.stdout.write(JSON.stringify(layer.raw, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: config show failed: ${msg}\n`);
    return 1;
  }
}

// ─── get ────────────────────────────────────────────────────────────────────

export async function configGetCommand(args: { path: string }): Promise<number> {
  try {
    const schema = inferPathSchema(args.path);
    if (schema.kind === "unknown_path") {
      process.stderr.write(`huko config get: unknown config path: ${args.path}\n`);
      return 3;
    }

    loadConfig({ cwd: process.cwd() });
    const resolved = getConfig() as unknown;
    const parts = parsePath(args.path);
    const value = getValueByPath(resolved, parts);

    // Report which layer set the effective value (highest-priority layer
    // whose raw payload contains the path). Defaults to "default" since
    // `DEFAULT_CONFIG` is always layer 0.
    const layers = getConfigLayers();
    let sourceLabel = "default";
    let sourcePath: string | undefined;
    for (const layer of layers) {
      if (getValueByPath(layer.raw as unknown, parts) !== undefined) {
        sourceLabel = layer.source;
        sourcePath = layer.path;
      }
    }

    if (schema.kind === "leaf") {
      const printed =
        typeof value === "string"
          ? value
          : value === undefined
            ? "(unset)"
            : JSON.stringify(value);
      const where = sourcePath ? ` (set in ${sourceLabel}: ${sourcePath})` : ` (from ${sourceLabel})`;
      process.stdout.write(`${args.path} = ${printed}${where}\n`);
    } else {
      // not_a_leaf — print the whole subtree as JSON for inspection
      const where = sourcePath ? ` (set in ${sourceLabel}: ${sourcePath})` : ` (from ${sourceLabel})`;
      process.stdout.write(`${args.path}${where}\n`);
      process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: config get failed: ${msg}\n`);
    return 1;
  }
}

// ─── set ────────────────────────────────────────────────────────────────────

export async function configSetCommand(args: {
  path: string;
  value: string;
  scope: ConfigScope;
}): Promise<number> {
  try {
    const result = setConfigValue({
      path: args.path,
      value: args.value,
      scope: args.scope,
      cwd: process.cwd(),
    });
    if (!result.ok) {
      process.stderr.write(`huko config set: ${result.error}\n`);
      return 3;
    }
    const where = args.scope === "global" ? "global" : "project";
    const printedPrev =
      result.previous === undefined ? "(unset)" : JSON.stringify(result.previous);
    const printedNext = JSON.stringify(result.next);
    process.stderr.write(
      `huko: ${args.path} ${printedPrev} → ${printedNext}  [${where}: ${result.filePath}]\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: config set failed: ${msg}\n`);
    return 1;
  }
}

// ─── unset ──────────────────────────────────────────────────────────────────

export async function configUnsetCommand(args: {
  path: string;
  scope: ConfigScope;
}): Promise<number> {
  try {
    const result = unsetConfigValue({
      path: args.path,
      scope: args.scope,
      cwd: process.cwd(),
    });
    if (!result.ok) {
      process.stderr.write(`huko config unset: ${result.error}\n`);
      return 3;
    }
    const where = args.scope === "global" ? "global" : "project";
    if (!result.removed) {
      process.stderr.write(
        `huko: ${args.path} was not set in ${where} (${result.filePath}); nothing to do\n`,
      );
      return 0;
    }
    const printedPrev = JSON.stringify(result.previous);
    process.stderr.write(
      `huko: removed ${args.path} (was ${printedPrev})  [${where}: ${result.filePath}]\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: config unset failed: ${msg}\n`);
    return 1;
  }
}
