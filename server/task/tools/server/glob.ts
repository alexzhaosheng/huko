/**
 * Tool: glob
 *
 * Find files matching a glob pattern. Returns absolute paths sorted by
 * mtime (most recently modified first) — usually what an agent wants
 * ("show me the latest test file" / "what was last touched").
 *
 * Backend: Node's built-in `fs.globSync` (Node 22+). Supports the
 * standard `*` / `**` / `?` / `[...]` patterns and brace expansion.
 *
 * Defaults:
 *   - Excludes the noisy directories (`.git`, `node_modules`, `dist`,
 *     etc.) unless the LLM passes `include_hidden: true`.
 *   - Capped at 1000 results — agents that hit the cap should narrow
 *     the pattern, not page through.
 *
 * Cross-platform: `fs.globSync` handles platform path separators.
 * Output paths are always forward-slash so the LLM's responses can
 * feed straight back into other tools without escaping.
 */

import { globSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_IGNORE_DIRS,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const MAX_RESULTS = 1000;

const DESCRIPTION =
  "Find files by glob pattern. Returns absolute paths sorted by modification time (newest first).\n\n" +
  "<patterns>\n" +
  "Standard glob syntax: `*` (any chars except `/`), `**` (any depth), `?` (single char), `[abc]` (char class), `{a,b}` (alternation).\n" +
  "Examples: `**/*.ts`, `src/**/test_*.py`, `*.{js,jsx,ts,tsx}`.\n" +
  "</patterns>\n\n" +
  "<defaults>\n" +
  "- Excludes `.git`, `node_modules`, `dist`, `build`, `target`, `__pycache__`, etc. — set `include_hidden: true` to include them.\n" +
  "- Up to 1000 matches; agents that hit the cap should narrow the pattern (e.g. `src/**/*.ts` instead of `**/*.ts`).\n" +
  "- Sorted by mtime descending; the newest-modified files appear first.\n" +
  "</defaults>\n\n" +
  "<instructions>\n" +
  "- Use this when you know the filename shape but not the exact location.\n" +
  "- Use `grep` when you need to search file CONTENTS (the regex engine is built-in).\n" +
  "- `cwd` defaults to the process working directory; pass it to scope the search to a sub-tree.\n" +
  "</instructions>";

registerServerTool(
  {
    name: "glob",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match against file paths.",
        },
        cwd: {
          type: "string",
          description:
            "Directory to search within. Absolute or relative to the process working directory. Defaults to cwd.",
        },
        include_hidden: {
          type: "boolean",
          description:
            "Include matches inside hidden / build / cache directories (.git, node_modules, dist, etc.). Default false.",
        },
      },
      required: ["pattern"],
    },
    dangerLevel: "safe",
  },
  async (args): Promise<ToolHandlerResult> => {
    const pattern = String(args["pattern"] ?? "").trim();
    if (!pattern) {
      return { content: "Error: `pattern` is required.", error: "missing pattern" };
    }
    const includeHidden = args["include_hidden"] === true;
    const rawCwd = args["cwd"] !== undefined ? String(args["cwd"]).trim() : "";
    const cwdAbs = rawCwd ? resolvePath(rawCwd) : process.cwd();

    let raw: string[];
    try {
      // Node's globSync emits paths relative to its `cwd` option by
      // default; we want absolute paths in the LLM-facing output.
      const exclude = includeHidden
        ? undefined
        : (p: string): boolean => {
            // p is relative to cwdAbs; check each segment.
            const segs = p.split(/[\\/]/);
            for (const s of segs) {
              if (DEFAULT_IGNORE_DIRS.has(s)) return true;
            }
            return false;
          };
      raw = globSync(pattern, {
        cwd: cwdAbs,
        ...(exclude !== undefined ? { exclude } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: glob failed for "${pattern}": ${msg}`,
        error: "glob failed",
      };
    }

    const absolutes = raw.map((r) => path.resolve(cwdAbs, r));

    // Annotate with mtime (skip entries that vanish between glob and
    // stat — possible on fast filesystems with concurrent writes).
    const withMtime: Array<{ p: string; mtime: number }> = [];
    for (const abs of absolutes) {
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue; // glob can match dirs; we list files
        withMtime.push({ p: abs, mtime: st.mtimeMs });
      } catch {
        /* gone — skip */
      }
    }

    withMtime.sort((a, b) => b.mtime - a.mtime);

    const truncated = withMtime.length > MAX_RESULTS;
    const kept = truncated ? withMtime.slice(0, MAX_RESULTS) : withMtime;

    if (kept.length === 0) {
      return {
        content: `<system-reminder>No files matched "${pattern}" under ${toPosixPath(cwdAbs)}.</system-reminder>`,
        summary: `glob ${pattern} (0 matches)`,
        metadata: { pattern, cwd: toPosixPath(cwdAbs), count: 0 },
      };
    }

    const lines = kept.map((e) => toPosixPath(e.p));
    let body = lines.join("\n");
    if (truncated) {
      body += `\n\n<system-reminder>Truncated at ${MAX_RESULTS} of ${withMtime.length} matches. Narrow the pattern (e.g. add a subdirectory prefix).</system-reminder>`;
    }

    return {
      content: body,
      summary: `glob ${pattern} (${kept.length}${truncated ? `/${withMtime.length}` : ""} matches)`,
      metadata: {
        pattern,
        cwd: toPosixPath(cwdAbs),
        count: kept.length,
        total: withMtime.length,
        truncated,
      },
    };
  },
);
