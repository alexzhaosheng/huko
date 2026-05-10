/**
 * Tool: grep
 *
 * Search file contents for a regex. Pure JS — no ripgrep dependency,
 * no native binary. Slower than rg on huge codebases but fast enough
 * for huko's "agent looks at one repo" workload (and avoids the pain
 * of shipping rg per-platform).
 *
 * Three output modes (ripgrep parity):
 *   - `files_with_matches` (default): just the file paths
 *   - `count`:                        per-file match counts
 *   - `content`:                      matching lines, with optional
 *                                     line numbers + before/after context
 *
 * Defaults match what an agent usually wants:
 *   - Recurses into the given path (or cwd) and skips noisy dirs
 *     (.git, node_modules, dist, etc.) unless `include_hidden`.
 *   - Single-file size cap: 5 MiB. Files larger than that are skipped
 *     with a stderr-style notice in the result, not a hard error.
 *   - Cap of 250 result lines (head_limit). 0 = unlimited (use sparingly).
 *
 * Cross-platform: 100% pure Node. No shelling out to grep/rg.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_IGNORE_DIRS,
  extensionsForType,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const MAX_FILE_BYTES_SCAN = 5 * 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 250;

const DESCRIPTION =
  "Search file contents using a regex.\n\n" +
  "<output_modes>\n" +
  "- `files_with_matches` (default): list paths of files containing at least one match. Cheap.\n" +
  "- `count`: list `<count>\\t<path>` per file with matches.\n" +
  "- `content`: list each matching line. Set `n: true` for line numbers, and `A`/`B`/`C` for context.\n" +
  "</output_modes>\n\n" +
  "<filtering>\n" +
  "- `path`: directory or single file. Defaults to cwd. Recurses into directories.\n" +
  "- `glob`: filter file paths by a glob (e.g. `**/*.ts`).\n" +
  "- `type`: shorthand for common languages (`js`, `ts`, `py`, `go`, `rust`, etc.). Maps to extensions internally.\n" +
  "- `ignore_case`: case-insensitive match. Default false.\n" +
  "- `multiline`: enable `s` flag (`.` matches newlines). Patterns can span lines. Default false.\n" +
  "</filtering>\n\n" +
  "<limits>\n" +
  "- Files larger than 5 MiB are skipped with a notice.\n" +
  "- Default cap of 250 result lines (`head_limit`). Set 0 for unlimited (use sparingly).\n" +
  "- Default ignored dirs: .git, node_modules, dist, build, target, __pycache__, etc. Set `include_hidden: true` to override.\n" +
  "</limits>\n\n" +
  "<instructions>\n" +
  "- For exact-string searches, escape regex metacharacters: `interface\\\\{\\\\}` to find `interface{}` in Go code.\n" +
  "- Use `output_mode: \"files_with_matches\"` for 'where is X mentioned'; use `\"content\"` only when you need to see the actual lines.\n" +
  "- Combine with `read_file` to load matching files in full once you've located them.\n" +
  "</instructions>";

type OutputMode = "files_with_matches" | "count" | "content";

registerServerTool(
  {
    name: "grep",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression to search for. Uses JS regex syntax.",
        },
        path: {
          type: "string",
          description: "Directory or single file to search. Defaults to cwd.",
        },
        glob: {
          type: "string",
          description:
            "Glob filter applied to candidate file paths (e.g. `**/*.ts`).",
        },
        type: {
          type: "string",
          description:
            "Shorthand for language file extensions: js, ts, py, go, rust, java, ruby, php, c, cpp, html, css, json, yaml, toml, md, sh, sql, etc.",
        },
        ignore_case: {
          type: "boolean",
          description: "Case-insensitive match. Default false.",
        },
        multiline: {
          type: "boolean",
          description:
            "Allow `.` to match newlines and the pattern to span lines. Default false.",
        },
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "count", "content"],
          description:
            "How to format results. Default `files_with_matches`.",
        },
        head_limit: {
          type: "number",
          description:
            "Cap on result lines. Default 250. Pass 0 for no limit (large result sets waste context).",
        },
        n: {
          type: "boolean",
          description:
            "Include line numbers (only meaningful in `content` mode).",
        },
        A: {
          type: "number",
          description:
            "Lines AFTER each match (content mode only). Default 0.",
        },
        B: {
          type: "number",
          description:
            "Lines BEFORE each match (content mode only). Default 0.",
        },
        C: {
          type: "number",
          description:
            "Symmetric context: equivalent to setting both A and B to this value (content mode only).",
        },
        include_hidden: {
          type: "boolean",
          description:
            "Search inside hidden / build / cache directories. Default false.",
        },
      },
      required: ["pattern"],
    },
    dangerLevel: "safe",
  },
  async (args): Promise<ToolHandlerResult> => {
    const pattern = String(args["pattern"] ?? "");
    if (!pattern) {
      return { content: "Error: `pattern` is required.", error: "missing pattern" };
    }
    const ignoreCase = args["ignore_case"] === true;
    const multiline = args["multiline"] === true;
    const outputMode: OutputMode =
      args["output_mode"] === "count"
        ? "count"
        : args["output_mode"] === "content"
          ? "content"
          : "files_with_matches";
    const headLimit = clampNonNegativeInt(args["head_limit"], DEFAULT_HEAD_LIMIT);
    const showLineNumbers = args["n"] === true;
    const rawPath = args["path"] !== undefined ? String(args["path"]).trim() : "";
    const root = resolvePath(rawPath || process.cwd());
    const includeHidden = args["include_hidden"] === true;
    const globFilter = args["glob"] !== undefined ? String(args["glob"]).trim() : "";
    const typeFilter = args["type"] !== undefined ? String(args["type"]).trim() : "";
    const C = clampNonNegativeInt(args["C"], 0);
    const A = clampNonNegativeInt(args["A"], C);
    const B = clampNonNegativeInt(args["B"], C);

    let extensions: string[] | null = null;
    if (typeFilter) {
      extensions = extensionsForType(typeFilter);
      if (!extensions) {
        return {
          content: `Error: unknown \`type\` "${typeFilter}". Use a known shorthand or omit the field and use \`glob\` instead.`,
          error: "unknown type",
        };
      }
    }

    let regex: RegExp;
    try {
      let flags = "g";
      if (ignoreCase) flags += "i";
      if (multiline) flags += "s";
      regex = new RegExp(pattern, flags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: invalid regex "${pattern}": ${msg}`,
        error: "invalid regex",
      };
    }

    let globMatcher: ((p: string) => boolean) | null = null;
    if (globFilter) {
      try {
        globMatcher = compileGlob(globFilter);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: `Error: invalid glob "${globFilter}": ${msg}`,
          error: "invalid glob",
        };
      }
    }

    let rootStat;
    try {
      rootStat = statSync(root);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot stat ${toPosixPath(root)}: ${msg}`,
        error: "stat failed",
      };
    }

    // Collect candidate files.
    const candidates: string[] = [];
    if (rootStat.isFile()) {
      candidates.push(root);
    } else if (rootStat.isDirectory()) {
      collectFiles(root, candidates, {
        extensions,
        globMatcher,
        rootForGlob: root,
        includeHidden,
      });
    } else {
      return {
        content: `Error: ${toPosixPath(root)} is neither a file nor a directory.`,
        error: "bad target",
      };
    }

    // Search.
    const fileResults: Array<{
      path: string;
      matchCount: number;
      lines: Array<{ lineNo: number; text: string; kind: "match" | "context" }>;
    }> = [];
    const skipped: string[] = [];

    for (const fp of candidates) {
      let stat;
      try {
        stat = statSync(fp);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES_SCAN) {
        skipped.push(`${toPosixPath(fp)} (${formatBytes(stat.size)})`);
        continue;
      }

      let buf: Buffer;
      try {
        buf = readFileSync(fp);
      } catch {
        continue;
      }
      // Skip likely-binary content quickly.
      if (buf.includes(0)) continue;

      const text = buf.toString("utf8");

      if (multiline) {
        // multiline mode: match across the whole file, then map to line numbers.
        const matches = [...text.matchAll(regex)];
        if (matches.length === 0) continue;
        const file = { path: fp, matchCount: matches.length, lines: [] as typeof fileResults[number]["lines"] };
        if (outputMode === "content") {
          for (const m of matches) {
            const lineNo = posToLineNo(text, m.index ?? 0);
            const line = lineAt(text, m.index ?? 0);
            file.lines.push({ lineNo, text: line, kind: "match" });
          }
        }
        fileResults.push(file);
      } else {
        // line-oriented mode (the common path).
        const lines = text.split(/\r?\n/);
        const matchedLineSet = new Set<number>();
        const matchCountPerLine = new Map<number, number>();
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i]!;
          regex.lastIndex = 0;
          let cnt = 0;
          while (regex.exec(ln) !== null) {
            cnt++;
            if (regex.lastIndex === 0) break; // empty-match guard
          }
          if (cnt > 0) {
            matchedLineSet.add(i);
            matchCountPerLine.set(i, cnt);
          }
        }
        if (matchedLineSet.size === 0) continue;
        const totalCount = [...matchCountPerLine.values()].reduce((a, b) => a + b, 0);
        const file = { path: fp, matchCount: totalCount, lines: [] as typeof fileResults[number]["lines"] };
        if (outputMode === "content") {
          // Expand matched lines with B/A context.
          const visible = new Map<number, "match" | "context">();
          for (const idx of matchedLineSet) {
            for (let k = Math.max(0, idx - B); k <= Math.min(lines.length - 1, idx + A); k++) {
              if (!visible.has(k)) visible.set(k, "context");
            }
            visible.set(idx, "match");
          }
          const sorted = [...visible.keys()].sort((a, b) => a - b);
          for (const idx of sorted) {
            file.lines.push({
              lineNo: idx + 1,
              text: lines[idx] ?? "",
              kind: visible.get(idx) === "match" ? "match" : "context",
            });
          }
        }
        fileResults.push(file);
      }
    }

    // Render.
    const out: string[] = [];
    let lineCount = 0;
    let truncated = false;

    function pushLine(s: string): void {
      if (truncated) return;
      if (headLimit > 0 && lineCount >= headLimit) {
        truncated = true;
        return;
      }
      out.push(s);
      lineCount++;
    }

    if (outputMode === "files_with_matches") {
      for (const f of fileResults) pushLine(toPosixPath(f.path));
    } else if (outputMode === "count") {
      for (const f of fileResults) pushLine(`${f.matchCount}\t${toPosixPath(f.path)}`);
    } else {
      // content
      for (const f of fileResults) {
        if (truncated) break;
        pushLine(toPosixPath(f.path) + ":");
        for (const l of f.lines) {
          if (truncated) break;
          const prefix = showLineNumbers
            ? `${String(l.lineNo).padStart(6, " ")}${l.kind === "match" ? ":" : "-"}  `
            : "";
          pushLine(prefix + l.text);
        }
        pushLine(""); // separator between files
      }
    }

    if (out.length === 0 && skipped.length === 0) {
      return {
        content: `<system-reminder>No matches for /${pattern}/${ignoreCase ? "i" : ""}${multiline ? "s" : ""} under ${toPosixPath(root)}.</system-reminder>`,
        summary: `grep ${pattern} (0 matches)`,
        metadata: { pattern, root: toPosixPath(root), files: 0 },
      };
    }

    const trailers: string[] = [];
    if (truncated) {
      trailers.push(
        `<system-reminder>Output truncated at ${headLimit} lines. Increase head_limit or narrow the search (path/glob/type).</system-reminder>`,
      );
    }
    if (skipped.length > 0) {
      trailers.push(
        `<system-reminder>Skipped ${skipped.length} file(s) larger than ${formatBytes(MAX_FILE_BYTES_SCAN)}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""}.</system-reminder>`,
      );
    }

    return {
      content:
        out.join("\n") + (trailers.length > 0 ? "\n\n" + trailers.join("\n\n") : ""),
      summary: `grep ${pattern} (${fileResults.length} files, ${lineCount} lines)`,
      metadata: {
        pattern,
        root: toPosixPath(root),
        outputMode,
        files: fileResults.length,
        lines: lineCount,
        truncated,
        skipped: skipped.length,
      },
    };
  },
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectFiles(
  rootAbs: string,
  out: string[],
  opts: {
    extensions: string[] | null;
    globMatcher: ((p: string) => boolean) | null;
    rootForGlob: string;
    includeHidden: boolean;
  },
): void {
  function walk(dirAbs: string): void {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!opts.includeHidden) {
        if (e.name.startsWith(".")) continue;
        if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
      }
      const full = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (opts.extensions) {
          const ext = path.extname(e.name).toLowerCase();
          if (!opts.extensions.includes(ext)) continue;
        }
        if (opts.globMatcher) {
          // Use POSIX-form relative path for glob matching.
          const rel = toPosixPath(path.relative(opts.rootForGlob, full));
          if (!opts.globMatcher(rel)) continue;
        }
        out.push(full);
      }
    }
  }
  walk(rootAbs);
}

/**
 * Compile a glob pattern to a predicate. Supports `*` (no `/`), `**`,
 * `?`, `[abc]` and brace `{a,b}` alternation. Anchors at both ends.
 */
function compileGlob(pattern: string): (p: string) => boolean {
  // Tokenise braces first — `{a,b,c}` → `(a|b|c)`.
  let s = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) {
        s += "\\{";
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      const alts = inner.split(",").map((a) => a.replace(/[.+^$()|\\]/g, "\\$&"));
      s += "(?:" + alts.join("|") + ")";
      i = end + 1;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        s += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        s += "[^/]*";
        i++;
      }
      continue;
    }
    if (c === "?") {
      s += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) {
        s += "\\[";
        i++;
        continue;
      }
      s += pattern.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[.+^$()|\\]/.test(c)) {
      s += "\\" + c;
    } else {
      s += c;
    }
    i++;
  }
  const re = new RegExp("^" + s + "$");
  return (p) => re.test(p);
}

function posToLineNo(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") n++;
  }
  return n;
}

function lineAt(text: string, pos: number): string {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const end = text.indexOf("\n", pos);
  return text.slice(start, end < 0 ? text.length : end);
}

function clampNonNegativeInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
