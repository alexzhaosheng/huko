/**
 * server/services/features/sidecars.ts
 *
 * Start/stop machinery for chat-mode sidecars.
 *
 * Sidecars are long-lived listeners owned by a Feature (see
 * `registry.ts`). They run only in chat mode — non-chat invocations
 * never call into this file, which is how "chat-only" is enforced
 * structurally rather than via a runtime mode flag passed to each
 * sidecar.
 *
 * On startup, failures of individual sidecars are collected and
 * returned rather than thrown. A sidecar that fights `EADDRINUSE`
 * with another huko process (browser extension service is the
 * canonical case) should not block chat from launching — chat-mode
 * bootstrap warns and continues. The caller decides the policy.
 */

import type { Sidecar, SidecarDeps } from "./registry.js";
import { getFeature } from "./registry.js";

// ─── Live state ──────────────────────────────────────────────────────────────

const running = new Map<string, Sidecar>();

// ─── Start ───────────────────────────────────────────────────────────────────

export type StartResult = {
  started: string[];
  failed: { name: string; error: unknown }[];
};

/**
 * Spawn sidecars for every feature in `enabledNames` that declares
 * one. Features without a sidecar are skipped silently (a tools-only
 * feature is perfectly valid).
 *
 * Per-sidecar errors are captured into `failed` and do NOT reject the
 * call. Idempotent against repeated calls only if `stopAllSidecars()`
 * ran in between — calling start twice without stop will double-start
 * and throw on the second `running.set` collision via the sidecar's
 * own port binding logic (which is the right failure mode).
 */
export async function startEnabledSidecars(
  enabledNames: Iterable<string>,
  deps: SidecarDeps,
): Promise<StartResult> {
  const started: string[] = [];
  const failed: { name: string; error: unknown }[] = [];

  for (const name of enabledNames) {
    const feature = getFeature(name);
    if (!feature?.sidecar) continue;

    try {
      await feature.sidecar.start(deps);
      running.set(name, feature.sidecar);
      started.push(name);
    } catch (error) {
      failed.push({ name, error });
    }
  }

  return { started, failed };
}

// ─── Stop ────────────────────────────────────────────────────────────────────

/**
 * Stop every currently running sidecar. Per-sidecar `stop()` errors
 * are logged but swallowed — we're shutting down, there's no useful
 * recovery, and one misbehaving sidecar should not prevent the others
 * from cleaning up. Idempotent: safe to call multiple times.
 */
export async function stopAllSidecars(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const [name, sc] of running) {
    pending.push(
      sc.stop().catch((err: unknown) => {
        console.error(`[huko] sidecar "${name}" stop() failed:`, err);
      }),
    );
  }
  await Promise.all(pending);
  running.clear();
}

/** Test-only: clear running tracking without calling stop(). */
export function _resetSidecarsForTests(): void {
  running.clear();
}
