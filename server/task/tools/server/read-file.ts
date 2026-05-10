/**
 * Tool: read_file
 *
 * Read a text file's contents. Returns the body with line numbers
 * prefixed (cat -n style) so the LLM can quote exact line numbers
 * back when it asks to edit.
 *
 * Defaults:
 *   - First 2000 lines of the file (use `offset` + `limit` to page).
 *   - Refuses files larger than MAX_FILE_BYTES (10 MiB) — these are
 *     almost always logs, generated artefacts, or binaries by mistake.
 *   - Refuses binary content. The LLM gets a clean error rather than
 *     a screen full of NUL bytes.
 *
 * Cross-platform: paths accepted as either absolute or relative to
 * `process.cwd()`. Output paths are normalised to forward slashes so
 * an LLM running on Windows can still feed paths back without
 * worrying about backslash escaping.
 */

import { readFileSync, statSync } from "node:fs";
import {
  MAX_FILE_BYTES,
  looksBinary,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const DEFAULT_LIMIT = 2000;

const DESCRIPTION =
  "Read the contents of a text file.\n\n" +
  "<output_format>\n" +
  "Each line is prefixed with `<line_number>\\t` so you can refer to specific lines when proposing edits. Line numbers start at 1.\n" +
  "</output_format>\n\n" +
  "<paging>\n" +
  "By default returns the first 2000 lines. For longer files, use `offset` (1-indexed line number to start at) and `limit` (max lines to return).\n" +
  "</paging>\n\n" +
  "<limits>\n" +
  "- Files larger than 10 MiB are refused — they're almost always logs, build artefacts, or binaries.\n" +
  "- Binary content (PNG/PDF/ZIP/etc.) is refused; you'll get a clean error rather than garbage.\n" +
  "- Empty files return a system reminder rather than an empty string.\n" +
  "</limits>\n\n" +
  "<instructions>\n" +
  "- Prefer reading whole files for substantial review; use offset/limit only for files larger than 2000 lines.\n" +
  "- Paths can be absolute or relative to the current working directory. Either form is fine.\n" +
  "- DO NOT use this tool to read directories — use `list_dir` instead.\n" +
  "</instructions>";

registerServerTool(
  {
    name: "read_file",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to cwd",
        },
        offset: {
          type: "number",
          description:
            "1-indexed line number to start reading from. Default 1 (start of file).",
        },
        limit: {
          type: "number",
          description: "Max lines to return. Default 2000.",
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
    const offset = clampPositiveInt(args["offset"], 1);
    const limit = clampPositiveInt(args["limit"], DEFAULT_LIMIT);

    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot stat ${display}: ${msg}`,
        error: "stat failed",
      };
    }
    if (stat.isDirectory()) {
      return {
        content: `Error: ${display} is a directory. Use \`list_dir\` to list its contents.`,
        error: "is directory",
      };
    }
    if (!stat.isFile()) {
      return {
        content: `Error: ${display} is not a regular file (symlinks/sockets/devices not supported).`,
        error: "not regular file",
      };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        content:
          `Error: ${display} is ${formatBytes(stat.size)} (cap is ${formatBytes(MAX_FILE_BYTES)}). ` +
          `If this is intentional, use \`bash\` with \`head\`/\`tail\`/\`grep\` to extract the relevant slice.`,
        error: "file too large",
      };
    }

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: cannot read ${display}: ${msg}`, error: "read failed" };
    }

    if (looksBinary(buf)) {
      return {
        content:
          `Error: ${display} appears to be binary (size ${formatBytes(stat.size)}). ` +
          `read_file only handles text files. If you need bytes, use a more specific tool or \`bash\`.`,
        error: "binary content",
      };
    }

    const text = buf.toString("utf8");
    if (text.length === 0) {
      return {
        content: `<system-reminder>The file ${display} exists but is empty.</system-reminder>`,
        summary: `read_file ${display} (empty)`,
        metadata: { path: display, size: 0, totalLines: 0 },
      };
    }

    // Split preserving original line endings — LF is the universal
    // separator in practice. Treat CRLF as LF for line counting.
    const allLines = text.split(/\r?\n/);
    const totalLines = allLines.length;
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(allLines.length, startIdx + limit);
    const slice = allLines.slice(startIdx, endIdx);
    const truncated = endIdx < totalLines || startIdx > 0;

    const numbered = slice
      .map((line, i) => `${startIdx + i + 1}\t${line}`)
      .join("\n");

    let footer = "";
    if (truncated) {
      const shown = `${startIdx + 1}..${endIdx}`;
      footer = `\n\n<system-reminder>Showing lines ${shown} of ${totalLines}. Use offset/limit to see more.</system-reminder>`;
    }

    return {
      content: numbered + footer,
      summary: `read_file ${display} (${slice.length}/${totalLines} lines)`,
      metadata: {
        path: display,
        size: stat.size,
        totalLines,
        returnedLines: slice.length,
        offset: startIdx + 1,
        limit,
        truncated,
      },
    };
  },
);

function clampPositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
