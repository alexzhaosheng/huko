/**
 * Tool: list_dir
 *
 * List the entries of a directory. Returns one line per entry,
 * `<type>  <size>  <name>` where type is `f` (file), `d` (directory),
 * or `l` (symlink). Sizes are skipped for directories.
 *
 * Defaults are tuned for "let me orient myself in this repo":
 *   - Skips noisy directories (.git, node_modules, dist, build, etc.)
 *     unless the LLM explicitly opts in via `include_hidden: true`.
 *   - Non-recursive by default. With `recursive: true`, defaults to
 *     depth 3 — agents that need to see deeper should bump `depth`
 *     explicitly so they're aware of the breadth they're requesting.
 *
 * Cross-platform: handled by Node's `readdirSync({ withFileTypes }).
 * Output paths are forward-slash regardless of host OS.
 */

import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_IGNORE_DIRS,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const DEFAULT_DEPTH = 3;
const MAX_ENTRIES = 1000;

const DESCRIPTION =
  "List the entries of a directory. Returns one line per entry, sorted with directories first then files alphabetically.\n\n" +
  "<output_format>\n" +
  "Each line: `<type>  <size>  <name>` where type is `f` (file), `d` (directory), or `l` (symlink). Sizes are bytes; directories show no size.\n" +
  "</output_format>\n\n" +
  "<defaults>\n" +
  "- Non-recursive (only direct children). Set `recursive: true` to descend.\n" +
  "- Hidden dotfiles AND noisy build/cache directories (.git, node_modules, dist, build, target, __pycache__, etc.) are skipped unless `include_hidden: true`.\n" +
  "- Recursive listing depth defaults to 3. Bump `depth` if you genuinely need deeper.\n" +
  "- Capped at 1000 entries; results are truncated with a notice if exceeded.\n" +
  "</defaults>\n\n" +
  "<instructions>\n" +
  "- Use `glob` (not list_dir with recursive=true) when you have a known filename pattern. It's faster and cleaner output.\n" +
  "- Use `list_dir` when you don't know the layout yet and want a directory overview.\n" +
  "- Paths can be absolute or relative to cwd.\n" +
  "</instructions>";

registerServerTool(
  {
    name: "list_dir",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path. Absolute or relative to cwd.",
        },
        recursive: {
          type: "boolean",
          description: "Descend into subdirectories. Default false.",
        },
        depth: {
          type: "number",
          description:
            "When recursive, max depth from `path`. Default 3. Ignored when recursive=false.",
        },
        include_hidden: {
          type: "boolean",
          description:
            "Include dotfiles and the default-ignored build/cache directories (.git, node_modules, etc.). Default false.",
        },
      },
      required: ["path"],
    },
    dangerLevel: "safe",
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawPath = String(args["path"] ?? "").trim();
    if (!rawPath) {
      return { content: "Error: `path` is required.", error: "missing path" };
    }
    const recursive = args["recursive"] === true;
    const depth = clampPositiveInt(args["depth"], DEFAULT_DEPTH);
    const includeHidden = args["include_hidden"] === true;

    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    let rootStat: ReturnType<typeof statSync>;
    try {
      rootStat = statSync(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot stat ${display}: ${msg}`,
        error: "stat failed",
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        content: `Error: ${display} is not a directory. Use \`read_file\` for files.`,
        error: "not a directory",
      };
    }

    const lines: string[] = [];
    let count = 0;
    let truncated = false;

    function shouldSkip(name: string): boolean {
      if (includeHidden) return false;
      if (name.startsWith(".")) return true;
      if (DEFAULT_IGNORE_DIRS.has(name)) return true;
      return false;
    }

    function walk(dirAbs: string, dirRel: string, currentDepth: number): void {
      if (truncated) return;
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return; // permission denied / vanished — skip silently
      }

      // Sort: directories first, then files; alphabetical within each group.
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });

      for (const e of entries) {
        if (shouldSkip(e.name)) continue;
        if (count >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const childRel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
        const fullPath = path.join(dirAbs, e.name);

        let kind: "f" | "d" | "l" | "?";
        if (e.isSymbolicLink()) kind = "l";
        else if (e.isDirectory()) kind = "d";
        else if (e.isFile()) kind = "f";
        else kind = "?";

        let sizeStr = "—";
        if (kind === "f") {
          try {
            sizeStr = String(statSync(fullPath).size);
          } catch {
            sizeStr = "?";
          }
        }
        lines.push(`${kind}  ${sizeStr.padStart(10, " ")}  ${childRel}`);
        count++;

        if (recursive && kind === "d" && currentDepth < depth) {
          walk(fullPath, childRel, currentDepth + 1);
          if (truncated) return;
        }
      }
    }

    walk(abs, "", 1);

    if (lines.length === 0) {
      return {
        content: `<system-reminder>Directory ${display} is empty (or every entry was filtered by include_hidden=false).</system-reminder>`,
        summary: `list_dir ${display} (empty)`,
        metadata: { path: display, count: 0 },
      };
    }

    let body = `Listing of ${display}` +
      (recursive ? ` (recursive, depth ${depth})` : "") +
      ":\n" +
      lines.join("\n");
    if (truncated) {
      body += `\n\n<system-reminder>Truncated at ${MAX_ENTRIES} entries. Use \`glob\` for pattern-based search instead of recursive listing.</system-reminder>`;
    }

    return {
      content: body,
      summary: `list_dir ${display} (${count} entries${truncated ? ", truncated" : ""})`,
      metadata: {
        path: display,
        count,
        truncated,
        recursive,
        depth: recursive ? depth : 1,
      },
    };
  },
);

function clampPositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}
