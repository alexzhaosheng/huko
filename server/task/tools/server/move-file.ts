/**
 * Tool: move_file
 *
 * Move (or rename) a file or directory. Same path-handling story as the
 * rest of the file family: source and target resolve against cwd via
 * `resolvePath`.
 *
 * Behaviour:
 *   - Refuses if the source does not exist
 *   - Refuses if the target exists, unless `overwrite: true`
 *   - Cross-device moves (EXDEV from `rename`) fall back to copy + unlink
 *     so moves across mount boundaries don't fail mysteriously
 *   - The parent directory of the target must already exist; we don't
 *     `mkdir -p` for you (use bash `mkdir -p` first if needed)
 *
 * `dangerLevel: "moderate"` — recoverable if you remember the source
 * path, unlike a delete.
 */

import {
  copyFileSync,
  cpSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import {
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const DESCRIPTION =
  "Move or rename a file or directory.\n\n" +
  "<instructions>\n" +
  "- Both `source` and `target` resolve against cwd if relative\n" +
  "- Refuses if `source` does not exist\n" +
  "- Refuses if `target` exists unless `overwrite: true` is passed\n" +
  "- The parent directory of `target` MUST exist; create it via `bash` with `mkdir -p` first if needed\n" +
  "- Cross-device moves are handled transparently (copy + unlink fallback)\n" +
  "- Both files and directories supported\n" +
  "</instructions>";

const PARAMETERS = {
  type: "object" as const,
  properties: {
    source: {
      type: "string" as const,
      description: "Path to move from. Absolute or cwd-relative.",
    },
    target: {
      type: "string" as const,
      description: "Destination path. Absolute or cwd-relative.",
    },
    overwrite: {
      type: "boolean" as const,
      description: "When true, allow replacing an existing target. Default false.",
    },
  },
  required: ["source", "target"],
};

registerServerTool(
  {
    name: "move_file",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    dangerLevel: "moderate",
  },
  async (args): Promise<ToolHandlerResult> => {
    const rawSource = args["source"];
    const rawTarget = args["target"];
    if (typeof rawSource !== "string" || rawSource.trim().length === 0) {
      return errorResult("source is required and must be non-empty");
    }
    if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) {
      return errorResult("target is required and must be non-empty");
    }
    const overwrite = args["overwrite"] === true;

    const srcAbs = resolvePath(rawSource);
    const tgtAbs = resolvePath(rawTarget);
    const srcDisplay = toPosixPath(srcAbs);
    const tgtDisplay = toPosixPath(tgtAbs);

    // Source must exist.
    let srcStat: ReturnType<typeof statSync>;
    try {
      srcStat = statSync(srcAbs);
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : "";
      if (code === "ENOENT") {
        return errorResult(`Source does not exist: ${srcDisplay}`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Cannot stat source ${srcDisplay}: ${msg}`);
    }

    // Target gate.
    if (!overwrite) {
      try {
        statSync(tgtAbs);
        return errorResult(
          `Target already exists: ${tgtDisplay}. Pass overwrite: true to replace it.`,
        );
      } catch (err: unknown) {
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as { code: string }).code
            : "";
        if (code !== "ENOENT") {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Cannot stat target ${tgtDisplay}: ${msg}`);
        }
        // ENOENT → good, target free.
      }
    }

    // Try `rename` first; fall back to copy + unlink on EXDEV.
    try {
      renameSync(srcAbs, tgtAbs);
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : "";
      if (code === "EXDEV") {
        try {
          if (srcStat.isDirectory()) {
            cpSync(srcAbs, tgtAbs, { recursive: true, errorOnExist: !overwrite });
            // After successful copy, remove the source tree.
            // rmSync(recursive) handles dirs; we import via Node's fs.
            const { rmSync } = await import("node:fs");
            rmSync(srcAbs, { recursive: true, force: true });
          } else {
            copyFileSync(srcAbs, tgtAbs);
            unlinkSync(srcAbs);
          }
        } catch (err2: unknown) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          return errorResult(
            `Cross-device move ${srcDisplay} → ${tgtDisplay} failed: ${msg2}`,
          );
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(
          `Move ${srcDisplay} → ${tgtDisplay} failed: ${msg}`,
        );
      }
    }

    return {
      content: `Moved: ${srcDisplay} → ${tgtDisplay}`,
      summary: `move_file → ${tgtDisplay}`,
      metadata: {
        source: srcDisplay,
        target: tgtDisplay,
        kind: srcStat.isDirectory() ? "directory" : "file",
        overwrite,
      },
    };
  },
);

function errorResult(message: string): ToolHandlerResult {
  return {
    content: `Error: ${message}`,
    error: message,
    summary: "move_file refused",
  };
}
