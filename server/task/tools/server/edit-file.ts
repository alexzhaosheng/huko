/**
 * Tool: edit_file
 *
 * Atomic find-and-replace edits with whitespace-tolerant fuzzy
 * fallback. Multi-edit: one tool call can apply many edits to a single
 * file, all-or-nothing — if any edit fails to match, NO changes are
 * written.
 *
 * Ported from WeavesAI's `file` tool (action="edit"). Same algorithm,
 * adapted to huko's single-process tool registry and ToolHandlerResult
 * return type. The fuzzy matching logic lives in `_fuzzy-edit.ts`
 * (also ported from WeavesAI).
 *
 * Why fuzzy fallback exists: LLMs frequently emit `find` strings with
 * wrong indentation (tab vs spaces, off-by-N spaces). Without fuzzy,
 * those edits fail with cryptic "string not found" errors. With
 * fuzzy, whitespace-only mismatches recover transparently and the
 * replacement is auto-aligned to the matched block's actual indent.
 *
 * Failure modes (loud, with hints):
 *   - find string not found anywhere → return clear error, list any
 *     candidate line where the first non-blank token of `find` appears
 *   - file doesn't exist → suggest write_file
 *   - file is binary → refuse
 *   - file too large → refuse
 *
 * No partial writes ever. Dry-run validates every edit before any
 * write hits disk.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  MAX_FILE_BYTES,
  looksBinary,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { fuzzyEdit } from "./_fuzzy-edit.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

type EditOp = {
  find: string;
  replace: string;
  /** When true, replace every occurrence. Default false (single replace). */
  all?: boolean;
};

const DESCRIPTION =
  "Apply one or more atomic find-and-replace edits to an existing text file.\n\n" +
  "<atomicity>\n" +
  "All edits are validated FIRST. If ANY edit's `find` string is not located (even with whitespace-tolerant fuzzy matching), NO changes are written. Either everything succeeds or nothing changes.\n" +
  "</atomicity>\n\n" +
  "<find_string_rules>\n" +
  "- `find` must match a unique substring in the file. The tool replaces the FIRST match unless `all: true` is passed.\n" +
  "- Include enough surrounding context (3+ lines is usually enough) to make the match unambiguous.\n" +
  "- Whitespace tolerance: if the exact string isn't found, the tool retries with whitespace-normalised matching (trailing spaces ignored, leading indent compared structurally). When fuzzy matching wins, the replacement's indentation is auto-aligned to the matched block.\n" +
  "- Edits are applied SEQUENTIALLY in array order. Each subsequent edit sees the previous edits' output.\n" +
  "</find_string_rules>\n\n" +
  "<instructions>\n" +
  "- For BRAND-NEW files, use `write_file` instead — edit_file only edits existing files.\n" +
  "- For full rewrites, also prefer `write_file`.\n" +
  "- Read the file first if you're unsure what's there. The numbered output of `read_file` is the easiest way to copy-paste exact `find` strings.\n" +
  "- Pass `all: true` ONLY when you want every occurrence replaced (e.g. variable rename across the file).\n" +
  "</instructions>";

registerServerTool(
  {
    name: "edit_file",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to cwd.",
        },
        edits: {
          type: "array",
          description:
            "Sequential list of edits. Each `{find, replace, all?}`; applied in order, all-or-nothing.",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description:
                  "Substring to locate. Must be unique unless `all: true`.",
              },
              replace: {
                type: "string",
                description: "Replacement text.",
              },
              all: {
                type: "boolean",
                description:
                  "Replace every occurrence rather than just the first. Default false.",
              },
            },
            required: ["find", "replace"],
          },
        },
      },
      required: ["path", "edits"],
    },
    dangerLevel: "moderate",
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawPath = String(args["path"] ?? "").trim();
    if (!rawPath) {
      return { content: "Error: `path` is required.", error: "missing path" };
    }

    const editsRaw = args["edits"];
    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      return {
        content:
          "Error: `edits` must be a non-empty array of {find, replace, all?} objects.",
        error: "missing edits",
      };
    }

    const edits: EditOp[] = [];
    for (let i = 0; i < editsRaw.length; i++) {
      const e = editsRaw[i] as Record<string, unknown> | null;
      if (!e || typeof e !== "object") {
        return {
          content: `Error: edits[${i}] is not an object.`,
          error: "bad edit shape",
        };
      }
      if (typeof e["find"] !== "string") {
        return {
          content: `Error: edits[${i}].find must be a string.`,
          error: "bad edit shape",
        };
      }
      if (typeof e["replace"] !== "string") {
        return {
          content: `Error: edits[${i}].replace must be a string.`,
          error: "bad edit shape",
        };
      }
      if (e["find"] === "") {
        return {
          content: `Error: edits[${i}].find is empty — cannot replace nothing.`,
          error: "empty find",
        };
      }
      const op: EditOp = {
        find: e["find"] as string,
        replace: e["replace"] as string,
      };
      if (e["all"] === true) op.all = true;
      edits.push(op);
    }

    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      return {
        content:
          `Error: ${display} not found. Use \`write_file\` to create new files; \`edit_file\` only edits existing ones.`,
        error: "not found",
      };
    }
    if (stat.isDirectory()) {
      return {
        content: `Error: ${display} is a directory.`,
        error: "is directory",
      };
    }
    if (!stat.isFile()) {
      return {
        content: `Error: ${display} is not a regular file.`,
        error: "not regular file",
      };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        content:
          `Error: ${display} is ${stat.size} bytes (cap is ${MAX_FILE_BYTES}). Use bash with sed/awk for huge files.`,
        error: "file too large",
      };
    }

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot read ${display}: ${msg}`,
        error: "read failed",
      };
    }
    if (looksBinary(buf)) {
      return {
        content: `Error: ${display} appears to be binary; edit_file only handles text files.`,
        error: "binary content",
      };
    }
    const original = buf.toString("utf8");

    // ── Dry-run: every edit must locate its `find` ──────────────────────
    let dry = original;
    const matchTypes: Array<"exact" | "fuzzy"> = [];
    const replacementCounts: number[] = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      if (edit.all) {
        let result = fuzzyEdit(dry, edit.find, edit.replace);
        if (!result) {
          return notFoundError(i, edit, dry, display);
        }
        let count = 0;
        while (result) {
          count++;
          matchTypes.push(result.matchType);
          dry = result.content;
          result = fuzzyEdit(dry, edit.find, edit.replace);
        }
        replacementCounts.push(count);
      } else {
        const result = fuzzyEdit(dry, edit.find, edit.replace);
        if (!result) {
          return notFoundError(i, edit, dry, display);
        }
        matchTypes.push(result.matchType);
        dry = result.content;
        replacementCounts.push(1);
      }
    }

    // ── Apply for real ───────────────────────────────────────────────────
    let content = original;
    const reports: string[] = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      if (edit.all) {
        let count = 0;
        let result = fuzzyEdit(content, edit.find, edit.replace);
        while (result) {
          count++;
          content = result.content;
          result = fuzzyEdit(content, edit.find, edit.replace);
        }
        reports.push(
          `#${i + 1}: ${preview(edit.find)} → ${preview(edit.replace)} (all: ${count} replacements)`,
        );
      } else {
        // Dry-run already proved this matches; non-null is guaranteed.
        const result = fuzzyEdit(content, edit.find, edit.replace)!;
        content = result.content;
        const note = result.matchType === "fuzzy" ? " (fuzzy match, indentation auto-aligned)" : "";
        reports.push(
          `#${i + 1}: ${preview(edit.find)} → ${preview(edit.replace)}${note}`,
        );
      }
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

    const fuzzyCount = matchTypes.filter((t) => t === "fuzzy").length;
    const fuzzyTail =
      fuzzyCount > 0
        ? `\n(${fuzzyCount} of ${edits.length} edit(s) used fuzzy whitespace-tolerant matching)`
        : "";

    return {
      content:
        `Edited ${display}\n` +
        `Applied ${edits.length} edit(s):\n` +
        reports.join("\n") +
        `\nFile size: ${content.length} chars` +
        fuzzyTail,
      summary: `edit_file ${display} (${edits.length} edits)`,
      metadata: {
        path: display,
        editsApplied: edits.length,
        replacementCounts,
        fuzzyEdits: fuzzyCount,
        size: content.length,
      },
    };
  },
);

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, "↵");
  return oneLine.length > 50 ? `"${oneLine.slice(0, 50)}…"` : `"${oneLine}"`;
}

function notFoundError(
  i: number,
  edit: EditOp,
  content: string,
  display: string,
): ToolHandlerResult {
  const lines = content.split("\n");
  const findFirst = edit.find.split("\n")[0]?.trim() ?? "";
  let hint = "";
  if (findFirst.length > 5) {
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (lines[lineIdx]!.includes(findFirst)) {
        hint =
          `\nHint: line ${lineIdx + 1} contains similar text: "${lines[lineIdx]!.trim().slice(0, 120)}"\n` +
          `Note: fuzzy (whitespace-tolerant) matching was also attempted but failed — non-whitespace content does not match.`;
        break;
      }
    }
  }
  return {
    content:
      `Error: edit #${i + 1} could not locate its \`find\` string (exact AND fuzzy match both failed).\n` +
      `File: ${display} (${lines.length} lines)\n` +
      `Looking for: ${preview(edit.find)}${hint}\n` +
      `No changes were applied (atomic operation).`,
    error: "find not located",
  };
}
