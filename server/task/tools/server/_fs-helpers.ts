/**
 * server/task/tools/server/_fs-helpers.ts
 *
 * Cross-platform filesystem helpers shared by file/glob/grep tools.
 * Underscore prefix marks this as a tools-internal module — not part
 * of the public surface, not re-exported from tools/index.ts.
 *
 * What's here:
 *   - `resolvePath(p)` — normalise + resolve a path relative to
 *     process.cwd(). All file tools accept either absolute paths or
 *     paths relative to where huko was invoked.
 *   - `looksBinary(buf, len)` — quick binary-content detector. We
 *     refuse to feed binary file contents to the LLM as text — return
 *     an error instead. Cheap heuristic, NOT a full content sniff.
 *   - `DEFAULT_IGNORE_DIRS` — directories that file/glob/grep tools
 *     skip by default. Matches what most coding agents (Claude Code,
 *     ripgrep with default ignore, etc.) skip.
 *   - `MAX_FILE_BYTES` — single-file size cap shared across read_file,
 *     grep (per-file scan).
 *
 * No platform branches in this module — Node's `path.resolve`,
 * `fs.readFileSync`, etc. handle Windows `\` ↔ POSIX `/` normalisation.
 * We always emit forward-slash paths in output (consistent for the
 * LLM regardless of host OS) but accept either on input.
 */

import * as path from "node:path";

/** Hard cap for any single file we read or scan. 10 MiB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Directory names skipped unless the LLM explicitly opts in. */
export const DEFAULT_IGNORE_DIRS = new Set<string>([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",        // Rust
  ".gradle",       // Java/Kotlin
  ".idea",         // JetBrains
  ".vscode",       // VS Code
  ".DS_Store",     // macOS — file, but cheap to keep here
]);

/**
 * Resolve a user-supplied path:
 *   - absolute → returned as-is (after normalisation)
 *   - relative → resolved against process.cwd()
 *
 * On Windows, `path.resolve` produces `C:\foo\bar`. To keep output
 * consistent for the LLM, callers should run the result through
 * `toPosixPath()` before showing it.
 */
export function resolvePath(p: string): string {
  return path.resolve(p);
}

/**
 * Convert a platform-native path to forward-slash form for LLM-facing
 * output. `C:\foo\bar` → `C:/foo/bar`. POSIX paths pass through.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Quick "looks binary?" check on a Buffer slice. Heuristic:
 *   - Any NUL byte in the first `sampleSize` bytes → binary.
 *   - More than 30% non-printable + non-whitespace bytes → binary.
 *
 * Cheap, not bulletproof. UTF-8 / UTF-16 / Latin-1 text passes; PNGs,
 * ZIPs, ELFs, PDFs reliably fail. Mostly here to keep us from feeding
 * 50 KB of garbage into an LLM context window.
 */
export function looksBinary(buf: Buffer, sampleSize: number = 4096): boolean {
  const len = Math.min(buf.length, sampleSize);
  if (len === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i]!;
    if (b === 0) return true; // NUL strongly implies binary
    // Printable ASCII (0x20..0x7E) + tab/newline/CR/form-feed/vertical-tab
    if (
      (b >= 0x20 && b <= 0x7e) ||
      b === 0x09 ||
      b === 0x0a ||
      b === 0x0c ||
      b === 0x0d ||
      b === 0x0b ||
      // Allow high bits — UTF-8 multi-byte sequences
      b >= 0x80
    ) {
      continue;
    }
    nonPrintable++;
  }
  return nonPrintable / len > 0.3;
}

/**
 * Map a `type` short name (`js`, `py`, `rust`...) used by the grep
 * tool to a concrete extension list. Subset of ripgrep's defaults —
 * the most common ones for an agent. Returns null when the type is
 * unknown so the caller can warn the LLM rather than silently
 * matching everything.
 */
export function extensionsForType(type: string): string[] | null {
  const t = type.toLowerCase();
  switch (t) {
    case "js":
    case "javascript":
      return [".js", ".cjs", ".mjs"];
    case "ts":
    case "typescript":
      return [".ts", ".cts", ".mts", ".tsx"];
    case "jsx":
      return [".jsx", ".tsx"];
    case "py":
    case "python":
      return [".py", ".pyi"];
    case "go":
      return [".go"];
    case "rust":
    case "rs":
      return [".rs"];
    case "java":
      return [".java"];
    case "kotlin":
    case "kt":
      return [".kt", ".kts"];
    case "swift":
      return [".swift"];
    case "c":
      return [".c", ".h"];
    case "cpp":
    case "c++":
      return [".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh"];
    case "ruby":
    case "rb":
      return [".rb", ".erb"];
    case "php":
      return [".php"];
    case "shell":
    case "sh":
    case "bash":
      return [".sh", ".bash", ".zsh"];
    case "html":
      return [".html", ".htm"];
    case "css":
      return [".css", ".scss", ".sass", ".less"];
    case "json":
      return [".json"];
    case "yaml":
    case "yml":
      return [".yaml", ".yml"];
    case "toml":
      return [".toml"];
    case "md":
    case "markdown":
      return [".md", ".markdown"];
    case "sql":
      return [".sql"];
    default:
      return null;
  }
}
