/**
 * server/cli/state.ts
 *
 * Per-cwd CLI state — currently just the active chat-session id.
 *
 * Lives at `<cwd>/.huko/state.json`:
 *   { "activeSessionId": 42 }
 *
 * The active session is the implicit target for `huko run "..."` when
 * neither `--session=<id>` nor `--new` is passed. Sets are written
 * atomically (write-then-rename) so a crashed process can't leave a
 * half-written JSON.
 *
 * NOT used in `--memory` mode — ephemeral runs always create a fresh
 * in-memory session and never read or write state.json.
 *
 * NOTE: this state file is per-project (per-cwd). Two terminals open
 * in the same directory share the same active session pointer; opening
 * huko in a different cwd gives you a different active session
 * (different `.huko/` entirely). That's deliberate — different
 * projects = different conversation lines.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export type CwdState = {
  /** The chat session every `huko run` defaults to. Cleared by `--new`. */
  activeSessionId?: number;
};

/**
 * Read `<cwd>/.huko/state.json`. Returns `{}` when missing or malformed
 * — callers treat "no active session" the same way regardless of cause.
 */
export function readCwdState(cwd: string): CwdState {
  const p = stateFilePath(cwd);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CwdState = {};
    const id = (parsed as Record<string, unknown>)["activeSessionId"];
    if (typeof id === "number" && Number.isInteger(id) && id > 0) {
      out.activeSessionId = id;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomically write `state.json`. Auto-creates `<cwd>/.huko/`.
 *
 * Pass `null` to clear `activeSessionId` (writes `{}` — file kept so
 * `huko sessions current` can distinguish "explicitly cleared" from
 * "never set" via a stat, even though the API doesn't currently care).
 */
export function writeCwdState(cwd: string, state: CwdState): void {
  const dir = path.join(cwd, ".huko");
  mkdirSync(dir, { recursive: true });
  const p = stateFilePath(cwd);
  const tmp = p + ".tmp";

  const body =
    state.activeSessionId !== undefined
      ? JSON.stringify({ activeSessionId: state.activeSessionId }, null, 2) + "\n"
      : "{}\n";

  writeFileSync(tmp, body, "utf8");
  // fsync to flush before rename — survive a hard crash mid-write.
  try {
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* fsync failure is non-fatal; the rename below still happens */
  }

  try {
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow */
    }
    throw err;
  }
}

/**
 * Convenience: read the active session id, or `null` if none.
 */
export function getActiveSessionId(cwd: string): number | null {
  return readCwdState(cwd).activeSessionId ?? null;
}

/**
 * Convenience: set (or clear, with `null`) the active session id.
 */
export function setActiveSessionId(cwd: string, id: number | null): void {
  const next: CwdState = id === null ? {} : { activeSessionId: id };
  writeCwdState(cwd, next);
}

// ─── Internals ───────────────────────────────────────────────────────────────

function stateFilePath(cwd: string): string {
  return path.join(cwd, ".huko", "state.json");
}
