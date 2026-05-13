/**
 * server/version.ts
 *
 * Single source of truth for huko's runtime version string.
 *
 * Strategy: read `version` from package.json at process startup
 * (cached after the first call). Same relative path works for both
 * layouts:
 *   - dev / `npm run huko` / `tsx server/cli/index.ts`:
 *     this file is at `<repo>/server/version.ts`, package.json at
 *     `<repo>/package.json` — i.e. `..` from `here`
 *   - production / `dist/cli.js` bundle:
 *     bundled module is at `<install>/dist/cli.js`, package.json at
 *     `<install>/package.json` — i.e. `..` from `here`
 *
 * Why not embed at build time: package.json is the canonical version
 * record. Reading it at runtime guarantees `huko --version` always
 * matches what `npm list` / `pip-style` introspection would report,
 * even if someone forgot to bump a constant somewhere.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

let cached: string | null = null;

export function getHukoVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cached = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    // Bundled in an unusual layout, package.json missing, malformed
    // JSON — never block the launch. The `--version` output just
    // shows "unknown" and an attentive user will spot the problem.
    cached = "unknown";
  }
  return cached;
}
