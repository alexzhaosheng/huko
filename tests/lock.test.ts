/**
 * tests/lock.test.ts
 *
 * Per-cwd advisory lock: `<cwd>/.huko/lock` containing { pid, ts }.
 * Stale-lock recovery via PID liveness or timestamp age. Acquire
 * timeout. Release / re-acquire round-trip.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProjectLock, releaseAllProjectLocks } from "../server/cli/lock.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-lock-test-"));
});

afterEach(() => {
  releaseAllProjectLocks();
  rmSync(cwd, { recursive: true, force: true });
});

describe("acquireProjectLock", () => {
  it("acquires when no holder", async () => {
    const result = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(result.kind, "acquired");
    if (result.kind === "acquired") result.lock.release();
  });

  it("creates the lock file at <cwd>/.huko/lock", async () => {
    const result = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(existsSync(join(cwd, ".huko", "lock")), true);
    if (result.kind === "acquired") result.lock.release();
  });

  it("release allows re-acquire", async () => {
    const r1 = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(r1.kind, "acquired");
    if (r1.kind === "acquired") r1.lock.release();

    const r2 = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(r2.kind, "acquired");
    if (r2.kind === "acquired") r2.lock.release();
  });

  it("times out when an active holder is alive", async () => {
    const r1 = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(r1.kind, "acquired");

    // Try to acquire again — should time out fast.
    const start = Date.now();
    const r2 = await acquireProjectLock(cwd, { timeoutMs: 200, pollIntervalMs: 50 });
    const elapsed = Date.now() - start;
    assert.equal(r2.kind, "timeout");
    if (r2.kind === "timeout") {
      assert.equal(r2.holder.pid, process.pid);
    }
    assert.ok(elapsed >= 150, `elapsed=${elapsed} should be >= 150`);
    assert.ok(elapsed < 1000, `elapsed=${elapsed} should be < 1000`);

    if (r1.kind === "acquired") r1.lock.release();
  });

  it("takes over a stale lock (dead PID)", async () => {
    // Manually plant a lock file with a PID that almost certainly
    // isn't running (using a high invented id; if it happens to exist
    // we skip).
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    const fakePid = 999_999_999;
    try {
      process.kill(fakePid, 0);
      // PID exists — skip the test gracefully.
      return;
    } catch {
      // Expected: ESRCH means no such process.
    }
    writeFileSync(
      join(cwd, ".huko", "lock"),
      JSON.stringify({ pid: fakePid, ts: Date.now() }),
    );

    const result = await acquireProjectLock(cwd, {
      timeoutMs: 200,
      staleMs: 30_000,
    });
    assert.equal(result.kind, "acquired");
    if (result.kind === "acquired") result.lock.release();
  });

  it("takes over a lock with stale timestamp", async () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    // Old timestamp — older than staleMs — even if a PID is alive
    // we treat it as stale.
    writeFileSync(
      join(cwd, ".huko", "lock"),
      JSON.stringify({ pid: process.pid, ts: Date.now() - 60_000 }),
    );

    const result = await acquireProjectLock(cwd, {
      timeoutMs: 200,
      staleMs: 30_000,
    });
    assert.equal(result.kind, "acquired");
    if (result.kind === "acquired") result.lock.release();
  });

  it("calls onWaiting once on first contention", async () => {
    const r1 = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(r1.kind, "acquired");

    let waitCallCount = 0;
    const r2 = await acquireProjectLock(cwd, {
      timeoutMs: 200,
      pollIntervalMs: 50,
      onWaiting: () => {
        waitCallCount += 1;
      },
    });
    assert.equal(r2.kind, "timeout");
    assert.equal(waitCallCount, 1);

    if (r1.kind === "acquired") r1.lock.release();
  });

  it("releaseAllProjectLocks() unlinks held files", async () => {
    const r = await acquireProjectLock(cwd, { timeoutMs: 100 });
    assert.equal(r.kind, "acquired");
    assert.equal(existsSync(join(cwd, ".huko", "lock")), true);

    releaseAllProjectLocks();
    assert.equal(existsSync(join(cwd, ".huko", "lock")), false);
  });
});
