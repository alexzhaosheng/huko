/**
 * server/task/tools/server/_shell-encoding.ts
 *
 * Windows-aware encoding helpers for the bash tool.
 *
 * Why this is non-trivial: on a Chinese / Japanese / Korean Windows
 * box, cmd.exe's default code page is GBK / Shift-JIS / etc., not
 * UTF-8. The naive fix — `chcp 65001` — turns out to break stdin echo
 * in pipe mode (cmd treats each UTF-8 byte as a separate character
 * when echoing back, garbling Chinese paths and command arguments).
 *
 * The robust strategy used here:
 *
 *   1. Probe the system code page once (via `chcp`), cache it.
 *   2. For stdout/stderr decoding: try UTF-8 first. Modern tooling
 *      (git, node, npm) emits UTF-8 even on Chinese Windows. If the
 *      buffer survives a UTF-8 round trip without producing U+FFFD
 *      and the byte length matches, take that. Otherwise decode with
 *      the system code page (cmd's own banner / prompt / `dir` output
 *      flows through this path).
 *   3. For stdin encoding on Windows: encode strings via the system
 *      code page before writing to the cmd.exe pipe. This makes the
 *      bytes line up with cmd's echo expectations.
 *
 * On POSIX shells everything is UTF-8 native; these helpers are
 * effectively pass-through.
 *
 * Cached state (`detectedAnsiCp`) is global to the module — there's
 * exactly one host machine, and its code page doesn't change at
 * runtime in any scenario worth modelling.
 */

import { spawnSync } from "node:child_process";
// iconv-lite is a CJS module — default-import gets its full
// module.exports object. `import * as iconv` would NOT reliably expose
// `.encodingExists` / `.encode` / `.decode` under Node ESM↔CJS interop
// (the namespace synthesis depends on whether the static analyser saw
// named exports, which CJS doesn't have).
import iconv from "iconv-lite";

let detectedAnsiCp: number | null | undefined = undefined;

/**
 * Returns the system ANSI code page (e.g. 936 for GBK on zh-CN
 * Windows, 932 for Shift-JIS on ja-JP) or `null` for non-Windows
 * hosts AND for hosts where probing failed. Cached after first call.
 */
export function detectSystemAnsiCp(): number | null {
  if (detectedAnsiCp !== undefined) return detectedAnsiCp;
  if (process.platform !== "win32") {
    detectedAnsiCp = null;
    return null;
  }
  try {
    const r = spawnSync("cmd", ["/c", "chcp"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    // chcp prints a number; localised wrappers (`Active code page:` /
    // `活动代码页:`) wrap it but the digits are stable.
    const m = out.match(/(\d{3,5})/);
    if (m) {
      detectedAnsiCp = parseInt(m[1]!, 10);
      return detectedAnsiCp;
    }
  } catch {
    // probe failed — fall through to null
  }
  detectedAnsiCp = null;
  return null;
}

/**
 * Round-trip UTF-8 validity check on a Buffer. The buffer is valid
 * UTF-8 iff Node's decode produces no replacement characters AND
 * encoding the result back yields the same byte length.
 *
 * Fast path: pure-ASCII buffers (every byte < 0x80) are trivially
 * valid UTF-8 — skip the round trip.
 */
export function isLikelyUtf8(buf: Buffer): boolean {
  let pureAscii = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]! >= 0x80) {
      pureAscii = false;
      break;
    }
  }
  if (pureAscii) return true;
  const decoded = buf.toString("utf-8");
  if (decoded.includes("�")) return false;
  return Buffer.byteLength(decoded, "utf-8") === buf.length;
}

/**
 * Decode a stdout/stderr chunk. On POSIX this is just UTF-8. On
 * Windows: UTF-8 first (modern tools), system ANSI fallback (cmd
 * itself, native Windows utilities).
 */
export function decodeShellOutput(buf: Buffer): string {
  if (process.platform !== "win32") return buf.toString("utf-8");
  const cp = detectSystemAnsiCp();
  // No probe result OR system is already UTF-8 → just decode UTF-8.
  if (cp === null || cp === 65001) return buf.toString("utf-8");
  // Try UTF-8 first; only fall back if it doesn't validate.
  if (isLikelyUtf8(buf)) return buf.toString("utf-8");
  const enc = `cp${cp}`;
  if (!iconv.encodingExists(enc)) return buf.toString("utf-8");
  return iconv.decode(buf, enc);
}

/**
 * Encode a string for writing to cmd.exe's stdin pipe on Windows.
 * Returns the original string unchanged on POSIX (the spawn pipe
 * accepts UTF-8 directly).
 *
 * On Windows we encode via the system ANSI code page. This is the
 * "stdin and stdout match in code page" half of the strategy: cmd
 * receives ANSI-encoded bytes, echoes them back as ANSI-encoded
 * bytes, and our decode path picks them up as ANSI on the way out.
 */
export function encodeShellInput(text: string): Buffer | string {
  if (process.platform !== "win32") return text;
  const cp = detectSystemAnsiCp();
  if (cp === null || cp === 65001) return text;
  const enc = `cp${cp}`;
  if (!iconv.encodingExists(enc)) return text;
  return iconv.encode(text, enc);
}
