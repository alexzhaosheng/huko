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

// ─── package.json version (runtime read) ────────────────────────────────────

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

// ─── build metadata (compile-time inject via esbuild --define) ──────────────

/**
 * `commit` and `date` populated by `scripts/build-cli.mjs` at bundle
 * time via esbuild's `--define`. In dev (running via tsx, no esbuild)
 * the constants are undefined and we report `null` so the formatter
 * can render a "(dev)" tag instead.
 *
 * The two `declare const` lines tell TypeScript the constants might
 * exist as global identifiers. The `typeof` guards inside the getter
 * are the runtime check — when esbuild substitutes the constants
 * inline, `typeof __HUKO_COMMIT__` becomes `typeof "abc1234"`
 * (= "string"). When unbundled, the identifier is undefined at the
 * global scope and `typeof` returns "undefined" without throwing.
 */
declare const __HUKO_COMMIT__: string | undefined;
declare const __HUKO_BUILD_DATE__: string | undefined;

export type BuildInfo = {
  /** Short git SHA at build time. */
  commit: string;
  /** ISO date YYYY-MM-DD when the bundle was built. */
  date: string;
};

export function getBuildInfo(): BuildInfo | null {
  const commit = typeof __HUKO_COMMIT__ !== "undefined" ? __HUKO_COMMIT__ : null;
  const date = typeof __HUKO_BUILD_DATE__ !== "undefined" ? __HUKO_BUILD_DATE__ : null;
  if (commit === null || date === null) return null;
  return { commit, date };
}

/**
 * Render the version string used by `--version` and the `huko --help`
 * header. Combines package.json version + build metadata when
 * available.
 *
 *   Bundled: `huko 0.2.0 (commit f996729, built 2026-05-13)`
 *   Dev:     `huko 0.2.0 (dev)`
 */
export function formatVersion(opts: { prefix?: string } = {}): string {
  const prefix = opts.prefix ?? "huko";
  const v = getHukoVersion();
  const bi = getBuildInfo();
  if (bi === null) return `${prefix} ${v} (dev)`;
  return `${prefix} ${v} (commit ${bi.commit}, built ${bi.date})`;
}
