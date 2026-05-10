/**
 * Tool: delete_file
 *
 * Remove a single file from disk. Refuses directories by default —
 * pass `recursive: true` to remove a directory tree.
 */

import { rmSync, statSync } from "node:fs";
import {
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const DESCRIPTION =
  "Delete a file from disk.\n\n" +
  "<instructions>\n" +
  "- Refuses directories unless `recursive: true` is passed (and even then, be sure)\n" +
  "- Refuses if the path does not exist — fix the path or check via `list_dir` first\n" +
  "- The path can be absolute or relative to cwd\n" +
  "- This is destructive and irreversible. Confirm via `message(type=ask)` before deleting tracked or user-authored files\n" +
  "- For removing a tracked git file, prefer `bash` with `git rm` so the staging area stays consistent\n" +
  "</instructions>";

const PARAMETERS = {
  type: "object" as const,
  properties: {
    path: {
      type: "string" as const,
      description: "Absolute or cwd-relative path to delete.",
    },
    recursive: {
      type: "boolean" as const,
      description:
        "When true, allows deleting a directory tree. Default false: directories are refused.",
    },
  },
  required: ["path"],
};

const DELETE_FILE_PROMPT_HINT = [
  "File deletion (`delete_file`):",
  "- Deletes are immediate and irreversible. Confirm via `message(type=ask)` before deleting tracked or user-authored files.",
  "- For removing a tracked git file, prefer `bash` with `git rm` so the staging area stays consistent.",
].join("\n");

registerServerTool(
  {
    name: "delete_file",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    dangerLevel: "dangerous",
    promptHint: DELETE_FILE_PROMPT_HINT,
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawPath = args["path"];
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return errorResult("path is required and must be non-empty");
    }
    const recursive = args["recursive"] === true;
    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : "";
      if (code === "ENOENT") {
        return errorResult(`No such file or directory: ${display}`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Cannot stat ${display}: ${msg}`);
    }

    if (stat.isDirectory() && !recursive) {
      return errorResult(
        `${display} is a directory; pass recursive: true to delete a directory tree.`,
      );
    }

    try {
      rmSync(abs, {
        recursive: recursive,
        force: false,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to delete ${display}: ${msg}`);
    }

    const what = stat.isDirectory() ? "directory" : "file";
    return {
      content: `Deleted ${what}: ${display}`,
      summary: `delete_file -> ${display}`,
      metadata: {
        path: display,
        kind: stat.isDirectory() ? "directory" : "file",
        recursive: recursive,
      },
    };
  },
);

function errorResult(message: string): ToolHandlerResult {
  return {
    content: `Error: ${message}`,
    error: message,
    summary: "delete_file refused",
  };
}
