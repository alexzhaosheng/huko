#!/usr/bin/env node
/**
 * scripts/build-cli.mjs
 *
 * Build wrapper around esbuild that embeds two compile-time constants
 * into `dist/cli.js`:
 *
 *   __HUKO_COMMIT__       short git SHA of HEAD when the bundle was built
 *   __HUKO_BUILD_DATE__   ISO date (YYYY-MM-DD) the bundle was built
 *
 * `server/version.ts` reads them via `typeof` guards: when esbuild
 * `--define`s them, they're string literals at the call site; when
 * the source runs unbundled (tsx, npm test, npm run huko), the
 * `typeof` check returns "undefined" and the version helpers fall
 * back to a "dev" indicator. So the same source works in both modes
 * without per-mode imports.
 *
 * Why a Node script instead of inline shell in the package.json
 * script: cross-platform. `$(git rev-parse ...)` is bash syntax that
 * PowerShell / cmd.exe don't expand, and esbuild's `--define` quoting
 * gets gnarly nested inside another shell. A 30-line Node script is
 * clearer and works the same on every contributor's machine + on
 * GitHub Actions runners.
 *
 * Failure modes are tolerant: not in a git repo / `git` not on PATH
 * → `commit` becomes the literal string "unknown". Build still
 * succeeds. Same with the date if Date.toISOString() somehow throws
 * (it won't, but defensive).
 */

import { execSync } from "node:child_process";
import { build } from "esbuild";

function shortGitSha() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function isoBuildDate() {
  try {
    return new Date().toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

const commit = shortGitSha();
const buildDate = isoBuildDate();

await build({
  entryPoints: ["server/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // esbuild's `define` does literal substitution at parse time. The
  // VALUE side has to be a JS source-level expression, hence
  // JSON.stringify to wrap the string in quotes.
  define: {
    __HUKO_COMMIT__: JSON.stringify(commit),
    __HUKO_BUILD_DATE__: JSON.stringify(buildDate),
  },
  // Match esbuild's own output line so the npm script feels the
  // same as the previous one-liner.
  logLevel: "info",
});

console.log(`  build metadata: commit=${commit} built=${buildDate}`);
