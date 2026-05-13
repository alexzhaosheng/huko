/**
 * server/security/atomic-write.ts
 *
 * Atomic + permission-tight file writes for credential-bearing JSON.
 *
 * Why this exists: the naive sequence `writeFileSync(p, data)` then
 * `chmodSync(p, 0o600)` has two problems:
 *
 *   1. **Permission race window**: between the write and the chmod, the
 *      file lives at the process umask (commonly 0644). Any local user
 *      can `open()` the inode in that gap.
 *   2. **Truncation on crash**: `writeFileSync` first truncates the
 *      target then writes. If the process dies mid-write, the file is
 *      left empty / partial — the entire vault is gone.
 *
 * The fix: write to `<path>.tmp.<pid>` with `mode: 0o600` in a single
 * `open(O_CREAT, mode)` call, then `renameSync` over the target.
 * `rename` is atomic on POSIX (and atomic-enough on Windows for our
 * use). At every observable instant, the target either has the old
 * content or the new content — never partial, never world-readable.
 *
 * Used by `keys.ts` and `vault.ts`; any new code persisting plaintext
 * secrets should go through here too.
 */

import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Write `data` to `p` atomically with file mode `mode` (0o600 for
 * credentials). Throws on I/O error; best-effort cleans up the temp
 * file if the rename never happened.
 */
export function atomicWriteFile(p: string, data: string, mode: number): void {
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode });
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist — ignore */
    }
    throw err;
  }
}
