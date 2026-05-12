#!/usr/bin/env node
/**
 * bin/huko.mjs
 *
 * Dual-mode launcher for the huko CLI. One file, two modes:
 *
 *   1. Production install (dist/cli.js present alongside us)
 *      → `import dist/cli.js` inline. No tsx, no subprocess.
 *      `npm install -g huko` users hit this path.
 *
 *   2. Dev / `npm link` (no dist, devDeps installed)
 *      → spawn tsx against `server/cli/index.ts`. Edits to source apply
 *        immediately — no build step needed during development.
 *
 * Why one file instead of two: avoids the "swap `bin` entry at publish
 * time" dance. `npm install huko` and a contributor's `npm link` both
 * route through here, and the right thing happens automatically.
 *
 * cwd is preserved either way — huko's per-cwd state (.huko/huko.db,
 * .huko/keys.json, .huko/state.json) lands wherever the user invoked
 * `huko ...`, not where huko itself lives.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist", "cli.js");

if (existsSync(dist)) {
  // Production: built artifact present, just run it.
  // Before doing so, check whether a co-located source tree (server/
  // and shared/) is newer than dist — i.e. the user pulled but forgot
  // to rebuild. Warn but still launch (the stale dist is a working
  // huko, just not the latest one). In a true npm-install layout the
  // source tree isn't shipped, so this check no-ops silently.
  warnIfStale(dist);
  await import(pathToFileURL(dist).href);
} else {
  // Dev fallback: spawn tsx on the .ts source. Cross-platform binary
  // name handled by checking process.platform.
  const { spawn } = await import("node:child_process");
  const cli = path.resolve(here, "..", "server", "cli", "index.ts");
  const tsxBin = path.resolve(
    here,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );

  if (!existsSync(tsxBin)) {
    process.stderr.write(
      "huko: neither dist/cli.js nor node_modules/.bin/tsx is present.\n" +
        "  - In a dev clone: run `npm install`, then retry.\n" +
        "  - For a production layout: run `npm run build:cli`.\n",
    );
    process.exit(1);
  }

  const child = spawn(tsxBin, [cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the signal we got (e.g. SIGINT) so our own exit code
      // reflects how tsx died, not a clean 0.
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

/**
 * Warn if any tracked source file is newer than dist/cli.js. Used to
 * catch the "pulled new commits but forgot to rebuild" footgun for
 * users who keep a local-built install (e.g. /usr/local/bin/huko →
 * <release-tree>/bin/huko.mjs and dist/cli.js next to it).
 *
 * Best-effort: any FS / permission error is swallowed so the launcher
 * never blocks on the diagnostic. Walks server/ + shared/ relative to
 * the bin directory; short-circuits on the first file newer than dist.
 * In a `npm install -g huko` layout these directories don't exist (the
 * package.json `files` array ships only bin + dist), so the check
 * silently no-ops.
 */
function warnIfStale(distPath) {
  try {
    const distMtime = statSync(distPath).mtimeMs;
    const root = path.resolve(here, "..");
    const newer = findNewerFile(
      [path.join(root, "server"), path.join(root, "shared")],
      distMtime,
    );
    if (newer === null) return;
    const rel = path.relative(root, newer);
    process.stderr.write(
      `huko: warning: dist/cli.js is older than ${rel} — ` +
        `run \`npm run build:cli\` to pick up the latest source.\n`,
    );
  } catch {
    /* swallow — diagnostic only */
  }
}

function findNewerFile(roots, thresholdMs) {
  const stack = [];
  for (const r of roots) {
    if (existsSync(r)) stack.push(r);
  }
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (statSync(p).mtimeMs > thresholdMs) return p;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return null;
}
