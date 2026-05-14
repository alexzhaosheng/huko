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

// Sanity-check the produced bundle by running `node dist/cli.js --version`
// and parsing the stdout. Without this, `npm publish` of a mis-built
// tree would ship `(dev)` to the registry and lie to every user about
// the version. The subprocess invocation is necessary because the
// bundle's entry runs `main()` on import — we can't just `import()`
// it for inspection. The check is one short spawn (~50ms) and catches
// dropped `--define`, accidentally-published source trees, etc.
const versionOut = execSync("node dist/cli.js --version", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

// `formatVersion()` shape: "huko vX.Y.Z (commit shortsha, built YYYY-MM-DD)"
// We don't pin the regex to the version; we just look for `commit <sha>`.
const m = /commit ([0-9a-f]+).*built (\d{4}-\d{2}-\d{2})/.exec(versionOut);
if (!m) {
  console.error(
    `  build check: dist/cli.js --version output did not include commit+date.\n` +
      `    output: ${JSON.stringify(versionOut)}\n` +
      `    expected: the esbuild --define for __HUKO_COMMIT__ / __HUKO_BUILD_DATE__\n` +
      `              to land in the bundle. \`huko --version\` would say (dev).\n` +
      `              Aborting build.`,
  );
  process.exit(1);
}
const [, bundleCommit, bundleDate] = m;
if (bundleCommit !== commit || bundleDate !== buildDate) {
  console.error(
    `  build check: bundled metadata doesn't match what we tried to inject.\n` +
      `    injected:  commit=${commit} built=${buildDate}\n` +
      `    in bundle: commit=${bundleCommit} built=${bundleDate}`,
  );
  process.exit(1);
}
console.log(`  build check:    bundle reports commit=${bundleCommit} date=${bundleDate}`);
