/**
 * server/cli/lock.ts
 *
 * Per-cwd advisory lock for `huko run`.
 *
 * Why: two `huko run` processes in the same directory would (a) both run
 * orphan recovery on startup — duplicating synthetic tool_results — and
 * (b) interleave user-message / assistant-turn appends on the same
 * active session, scrambling the conversation.
 *
 * SQLite WAL handles raw write serialisation, so other commands
 * (`sessions list`, `provider add`, etc.) don't need this lock. Only
 * `huko run` does, because it holds long-lived state during the LLM
 * call.
 *
 * Lock file: `<cwd>/.huko/lock` containing JSON `{ pid, ts }`. Acquired
 * via `openSync(O_WRONLY|O_CREAT|O_EXCL)` ("wx") — atomic on POSIX and
 * good-enough on Windows. Stale-lock detection if the holder is a dead
 * PID or its timestamp is older than `staleMs`.
 *
 * Daemon mode (when it lands) needs a different model — daemon owns the
 * lock for its lifetime, and CLI in same cwd should redirect to the
 * daemon via tRPC instead of fighting the lock.
 *
 * `--memory` mode skips the lock entirely (ephemeral runs are fully
 * independent — no shared on-disk state to coordinate).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";

export type ProjectLock = {
  /** Release the lock. Idempotent. */
  release(): void;
};

export type AcquireLockOptions = {
  /** Total wall-clock time to wait before giving up. Default 5000 ms. */
  timeoutMs?: number;
  /**
   * If an existing lock's timestamp is older than this, treat it as
   * stale (holder probably crashed without cleanup) and take over.
   * Default 30000 ms.
   */
  staleMs?: number;
  /** Poll interval while waiting. Default 100 ms. */
  pollIntervalMs?: number;
  /**
   * Called once the first time we hit contention, before sleeping.
   * Lets the CLI tell the user "waiting for another huko process ...".
   */
  onWaiting?: (info: LockHolderInfo) => void;
};

export type LockHolderInfo = {
  /** PID from the lock file, `null` if file was empty or unreadable. */
  pid: number | null;
  /** Epoch ms from the lock file, `null` if absent. */
  ts: number | null;
};

export type AcquireResult =
  | { kind: "acquired"; lock: ProjectLock }
  | { kind: "timeout"; holder: LockHolderInfo };

// ─── Process-wide cleanup ────────────────────────────────────────────────────

/**
 * Track every lock this process is holding. On `process.exit` we unlink
 * them — synchronous because exit handlers don't await. This catches
 * "uncaught exception → process.exit" and the second-Ctrl+C path. Also
 * called explicitly by the SIGINT handler in run.ts.
 */
const heldLocks = new Set<string>();
let exitHookInstalled = false;

function installExitHookOnce(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const p of heldLocks) {
      try {
        unlinkSync(p);
      } catch {
        /* swallow — we're exiting */
      }
    }
  });
}

/**
 * Release every lock this process is currently holding. Useful from
 * SIGINT handlers and other "exiting now" paths where the registered
 * `process.on('exit')` may not have fired yet.
 */
export function releaseAllProjectLocks(): void {
  for (const p of [...heldLocks]) {
    try {
      unlinkSync(p);
    } catch {
      /* swallow */
    }
    heldLocks.delete(p);
  }
}

// ─── Acquire ─────────────────────────────────────────────────────────────────

export async function acquireProjectLock(
  cwd: string,
  opts: AcquireLockOptions = {},
): Promise<AcquireResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;

  const dir = path.join(cwd, ".huko");
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock");

  installExitHookOnce();

  const start = Date.now();
  let warned = false;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      heldLocks.add(lockPath);
      return {
        kind: "acquired",
        lock: {
          release(): void {
            if (!heldLocks.has(lockPath)) return;
            heldLocks.delete(lockPath);
            try {
              unlinkSync(lockPath);
            } catch {
              /* swallow — file may have been wiped already */
            }
          },
        },
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Lock file exists. Check if stale.
      const info = readLockInfo(lockPath);

      if (isStale(info, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* swallow — someone else may have already cleaned up */
        }
        // Loop and retry create.
        continue;
      }

      // Active holder. Wait or time out.
      if (Date.now() - start >= timeoutMs) {
        return { kind: "timeout", holder: info };
      }

      if (!warned) {
        warned = true;
        opts.onWaiting?.(info);
      }

      await sleep(pollIntervalMs);
    }
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

function readLockInfo(p: string): LockHolderInfo {
  if (!existsSync(p)) return { pid: null, ts: null };
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      ts: typeof parsed.ts === "number" ? parsed.ts : null,
    };
  } catch {
    return { pid: null, ts: null };
  }
}

function isStale(info: LockHolderInfo, staleMs: number): boolean {
  // No PID + no timestamp → file probably half-written. Treat as stale.
  if (info.pid === null && info.ts === null) return true;

  // Timestamp very old → holder probably hard-crashed without cleanup.
  if (info.ts !== null && Date.now() - info.ts > staleMs) return true;

  // PID present — does the process still exist?
  if (info.pid !== null) {
    try {
      // signal 0 = existence check, doesn't actually deliver a signal.
      process.kill(info.pid, 0);
      return false; // process is alive
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true; // no such process — stale
      // EPERM means process exists but we can't signal it (different user
      // / privilege). Treat as alive — better to wait than to break their lock.
      return false;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
