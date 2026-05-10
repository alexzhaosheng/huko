/**
 * Tool: write_file
 *
 * Overwrite (or create) a text file with new content. Auto-creates
 * the parent directory chain if needed.
 *
 * Cross-platform: Node's fs APIs handle path separators. We always
 * write UTF-8. Line endings are preserved as the LLM provided them
 * (we don't normalise to CRLF on Windows — git tooling typically
 * handles eol=auto, and forcing CRLF would break repos that pin LF).
 *
 * Limits:
 *   - Refuses to overwrite a directory.
 *   - Caps content at 10 MiB — anything bigger is almost certainly
 *     a mistake (logs, generated artefacts, base64 blobs).
 *   - No diff preview here. Use `read_file` first if you want to
 *     compare; or `edit_file` for surgical changes.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  MAX_FILE_BYTES,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const DESCRIPTION =
  "Write a UTF-8 text file. Overwrites the file if it exists; creates it (and any missing parent directories) if it doesn't.\n\n" +
  "<instructions>\n" +
  "- For SURGICAL changes to existing files, prefer `edit_file` (find/replace). Use `write_file` for new files or full rewrites.\n" +
  "- Read the existing file first if you're rewriting — losing context is the #1 way to wreck working code.\n" +
  "- Line endings are preserved as you wrote them; the tool does not normalise CRLF/LF.\n" +
  "- Refuses paths that resolve to a directory or files larger than 10 MiB.\n" +
  "</instructions>";

registerServerTool(
  {
    name: "write_file",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to cwd",
        },
        content: {
          type: "string",
          description: "The full file contents to write (UTF-8)",
        },
      },
      required: ["path", "content"],
    },
    dangerLevel: "moderate",
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawPath = String(args["path"] ?? "").trim();
    if (!rawPath) {
      return { content: "Error: `path` is required.", error: "missing path" };
    }
    const content = args["content"];
    if (typeof content !== "string") {
      return {
        content: "Error: `content` is required and must be a string.",
        error: "missing content",
      };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        content: `Error: content is ${Buffer.byteLength(content, "utf8")} bytes, exceeds ${MAX_FILE_BYTES} (10 MiB) cap.`,
        error: "content too large",
      };
    }

    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    // Refuse if path exists as a directory.
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        return {
          content: `Error: ${display} is an existing directory; refusing to overwrite.`,
          error: "is directory",
        };
      }
    } catch {
      // doesn't exist — fine, we'll create it
    }

    // Auto-create parent dirs.
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot create parent directory for ${display}: ${msg}`,
        error: "mkdir failed",
      };
    }

    try {
      writeFileSync(abs, content, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot write ${display}: ${msg}`,
        error: "write failed",
      };
    }

    const lineCount = content.split(/\r?\n/).length;
    return {
      content: `Wrote ${display} — ${content.length} chars, ${lineCount} lines.`,
      summary: `write_file ${display}`,
      metadata: { path: display, size: content.length, lines: lineCount },
    };
  },
);
