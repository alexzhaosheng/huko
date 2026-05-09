/**
 * server/cli/commands/config.ts
 *
 * `huko config show` — print resolved config + per-layer source.
 *
 * Useful for "why is X not what I set?" debugging. Each layer is shown
 * separately so the operator sees: defaults → user → project → env →
 * explicit, in order, with the file path each came from.
 *
 * Returns `Promise<number>` (exit code). The single `process.exit()`
 * site is in `cli/index.ts`.
 *
 * Future verbs (sketched, not implemented yet):
 *   - `huko config get <path>`   read one value
 *   - `huko config set <path> <value>`   write to user-global config
 *   - `huko config edit`         open user config in $EDITOR
 *   - `huko config init`         scaffold an example config file
 */

import { loadConfig, getConfig, getConfigLayers } from "../../config/index.js";

export async function configShowCommand(): Promise<number> {
  try {
    // Ensure config is loaded (bootstrap normally does this; calling
    // again is idempotent and respects the same priority order).
    loadConfig({ cwd: process.cwd() });

    const resolved = getConfig();
    const layers = getConfigLayers();

    process.stdout.write("=== Resolved config ===\n");
    process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
    process.stdout.write("\n=== Layers (low → high priority) ===\n");
    for (const layer of layers) {
      const path = layer.path ? ` (${layer.path})` : "";
      process.stdout.write(`\n[${layer.source}]${path}\n`);
      process.stdout.write(JSON.stringify(layer.raw, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`huko: config show failed: ${msg}\n`);
    return 1;
  }
}
