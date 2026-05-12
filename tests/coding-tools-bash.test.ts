/**
 * tests/coding-tools-bash.test.ts
 *
 * Exercises the bash tool on the local platform (POSIX in CI / sandbox,
 * cmd.exe on Windows users' machines). Most assertions are
 * platform-agnostic: pick commands that exist in BOTH bash and cmd
 * (`echo`), or branch the assertion on `process.platform`.
 *
 * Cleanup: each test uses a fresh session id (so a previous test's
 * shell process can't leak in) and `destroyAllBashSessions` runs in
 * `afterEach` to keep idle processes from piling up.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../server/task/tools/index.js";
import { getTool } from "../server/task/tools/registry.js";
import { destroyAllBashSessions } from "../server/task/tools/server/bash.js";
import type { TaskContext } from "../server/engine/TaskContext.js";

const stubCtx = {} as unknown as TaskContext;
const isWin = process.platform === "win32";

let tmp: string;
let sessionCounter = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "huko-bash-"));
});
afterEach(async () => {
  await destroyAllBashSessions();
  // Windows can take a moment to release directory handles after the
  // child cmd.exe exits. Retry a few times before giving up.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function freshSession(): string {
  sessionCounter++;
  return `test_${process.pid}_${Date.now()}_${sessionCounter}`;
}

// ─── exec: happy paths ─────────────────────────────────────────────────────

describe("bash — exec basics", () => {
  it("runs a simple command and returns stdout + exit 0", async () => {
    const out = await invoke("bash", {
      action: "exec",
      command: "echo hello-world",
      session: freshSession(),
    });
    assert.equal(out.error, undefined);
    assert.match(out.content, /hello-world/);
    assert.match(out.content, /\[exit code: 0\]/);
  });

  it("captures non-zero exit codes", async () => {
    const cmd = isWin ? "cmd /c exit 42" : "exit 42";
    const out = await invoke("bash", {
      action: "exec",
      command: cmd,
      session: freshSession(),
    });
    assert.match(out.content, /\[exit code: 42\]/);
  });

  it("requires a command for exec", async () => {
    const out = await invoke("bash", { action: "exec", session: freshSession() });
    assert.equal(out.error, "missing command");
  });
});

// ─── exec: state persistence within a session ──────────────────────────────

describe("bash — session state survives across exec calls", () => {
  it("cwd set by `cd` persists into the next command", async () => {
    const sid = freshSession();
    // On Windows, cmd's `cd` does NOT change drive without `/d`.
    // huko process likely lives on E:, tmp is on C: — `/d` is mandatory.
    const cdCmd = isWin ? `cd /d "${tmp}"` : `cd "${tmp}"`;
    await invoke("bash", { action: "exec", command: cdCmd, session: sid });
    const pwdCmd = isWin ? "cd" : "pwd";
    const out = await invoke("bash", { action: "exec", command: pwdCmd, session: sid });
    // The command output should include our tmp's last path segment.
    const expectedFragment = tmp.split(/[\\/]/).filter(Boolean).slice(-1)[0]!;
    assert.match(out.content, new RegExp(expectedFragment));
  });

  it("env vars set in one exec are visible in the next", async () => {
    const sid = freshSession();
    if (isWin) {
      await invoke("bash", { action: "exec", command: "set HUKO_TEST_VAR=hello123", session: sid });
      const out = await invoke("bash", { action: "exec", command: "echo %HUKO_TEST_VAR%", session: sid });
      assert.match(out.content, /hello123/);
    } else {
      await invoke("bash", { action: "exec", command: "export HUKO_TEST_VAR=hello123", session: sid });
      const out = await invoke("bash", { action: "exec", command: 'echo "$HUKO_TEST_VAR"', session: sid });
      assert.match(out.content, /hello123/);
    }
  });

  it("two different session ids are independent", async () => {
    const a = freshSession();
    const b = freshSession();
    if (isWin) {
      await invoke("bash", { action: "exec", command: "set FOO=in_a", session: a });
      const out = await invoke("bash", { action: "exec", command: "echo %FOO%", session: b });
      // Var unset in session b → cmd echoes "%FOO%" literal
      assert.match(out.content, /%FOO%/);
    } else {
      await invoke("bash", { action: "exec", command: "export FOO=in_a", session: a });
      const out = await invoke("bash", { action: "exec", command: 'echo "${FOO:-not-set}"', session: b });
      assert.match(out.content, /not-set/);
    }
  });
});

// ─── exec: cwd parameter on session creation ───────────────────────────────

describe("bash — cwd on session creation", () => {
  it("starts the shell in the requested cwd", async () => {
    const sid = freshSession();
    const pwdCmd = isWin ? "cd" : "pwd";
    const out = await invoke("bash", {
      action: "exec",
      command: pwdCmd,
      session: sid,
      cwd: tmp,
    });
    const expectedFragment = tmp.split(/[\\/]/).filter(Boolean).slice(-1)[0]!;
    assert.match(out.content, new RegExp(expectedFragment));
  });
});

// ─── send + wait + view ─────────────────────────────────────────────────────

describe("bash — send / wait / view", () => {
  // Skip on Windows: cmd.exe's interactive prompt semantics differ
  // from POSIX. The CI we care about for "interactive" testing is
  // bash; Windows interactive support is exercised on real machines.
  it("send writes to stdin; subsequent view collects buffered output", { skip: isWin }, async () => {
    const sid = freshSession();
    // Start an interactive cat — anything we send to stdin gets echoed back to stdout.
    await invoke("bash", { action: "exec", command: "echo 'starting'", session: sid });
    // Use `read` to block on stdin
    await invoke("bash", { action: "send", session: sid, input: 'echo via_send_42\n' });
    // Give the shell a moment, then view what it produced.
    const view = await invoke("bash", {
      action: "wait",
      session: sid,
      timeout_ms: 1000,
    });
    assert.match(view.content, /via_send_42/);
  });

  it("wait without an active session reports it cleanly", async () => {
    const out = await invoke("bash", { action: "wait", session: "never-existed" });
    assert.match(out.content, /not found/);
  });

  it("view without an active session reports it cleanly", async () => {
    const out = await invoke("bash", { action: "view", session: "never-existed" });
    assert.match(out.content, /not found/);
  });
});

// ─── kill ───────────────────────────────────────────────────────────────────

describe("bash — kill", () => {
  it("kill removes a live session, follow-up exec recreates it", async () => {
    const sid = freshSession();
    await invoke("bash", { action: "exec", command: "echo first", session: sid });
    const k = await invoke("bash", { action: "kill", session: sid });
    assert.match(k.content, /terminated/);
    // Next exec should auto-recreate the session.
    const next = await invoke("bash", { action: "exec", command: "echo second", session: sid });
    assert.match(next.content, /second/);
  });

  it("kill on an unknown session is a clean no-op", async () => {
    const out = await invoke("bash", { action: "kill", session: "no-such-id" });
    assert.match(out.content, /not found/);
  });
});

// ─── timeout: command keeps running, follow-up wait collects rest ──────────

describe("bash — timeout doesn't kill the command", () => {
  it("returns timeout notice; later wait collects the late output", { skip: isWin }, async () => {
    const sid = freshSession();
    // Sleep 1 second then echo. timeout_ms=200 (idle) — we'll bail
    // because the command is silent for the whole 200ms window.
    const out = await invoke("bash", {
      action: "exec",
      command: "sleep 1 && echo finished_late",
      session: sid,
      timeout_ms: 200,
    });
    assert.match(out.content, /still running in this session/);
    // Wait for the command to finally finish.
    const late = await invoke("bash", { action: "wait", session: sid, timeout_ms: 3000 });
    assert.match(late.content, /finished_late/);
  });
});

// ─── idle timeout: streaming commands don't trip ───────────────────────────

describe("bash — idle timeout (timeout_ms) is reset by output", () => {
  it("a command that prints every 200ms with idle=600ms completes (NOT timed out)", { skip: isWin }, async () => {
    const sid = freshSession();
    // 5 lines, ~200ms apart. Total ~1000ms — would trip the OLD total-
    // timeout semantic (timeout_ms=600), but never has 600ms of silence
    // so the new idle semantic lets it finish.
    const out = await invoke("bash", {
      action: "exec",
      command:
        "for i in 1 2 3 4 5; do echo line_$i; sleep 0.2; done; echo done_marker",
      session: sid,
      timeout_ms: 600,
    });
    assert.doesNotMatch(out.content, /still running/, `unexpected timeout: ${out.content}`);
    assert.match(out.content, /done_marker/);
    assert.match(out.content, /line_1/);
    assert.match(out.content, /line_5/);
  });

  it("a silent command (sleep) DOES trip the idle timeout", { skip: isWin }, async () => {
    const sid = freshSession();
    const out = await invoke("bash", {
      action: "exec",
      command: "sleep 2 && echo too_late",
      session: sid,
      timeout_ms: 300,
    });
    assert.match(out.content, /idle timeout/);
    assert.match(out.content, /still running in this session/);
  });
});

// ─── total timeout: hard cap independent of output flow ────────────────────

describe("bash — total_timeout_ms (optional hard cap)", () => {
  it("trips even when the command is actively producing output", { skip: isWin }, async () => {
    const sid = freshSession();
    // Stream forever (well, for 30s — way past total cap). idle is
    // generous (5s), but total_timeout_ms=500 cuts in well before any
    // idle window could.
    const out = await invoke("bash", {
      action: "exec",
      command: "for i in $(seq 1 300); do echo tick_$i; sleep 0.05; done",
      session: sid,
      timeout_ms: 5000,
      total_timeout_ms: 500,
    });
    assert.match(out.content, /total timeout/);
    assert.match(out.content, /still running in this session/);
    // Should have captured several ticks before the cap fired.
    assert.match(out.content, /tick_/);
  });

  it("when undefined, no hard cap (streaming commands run to completion)", { skip: isWin }, async () => {
    const sid = freshSession();
    // No total cap; idle is enough for the 200ms gaps.
    const out = await invoke("bash", {
      action: "exec",
      command: "for i in 1 2 3; do echo n_$i; sleep 0.2; done",
      session: sid,
      timeout_ms: 600,
      // total_timeout_ms intentionally omitted
    });
    assert.doesNotMatch(out.content, /still running/);
    assert.match(out.content, /n_3/);
  });
});

// ─── output truncation ─────────────────────────────────────────────────────

describe("bash — output truncation at 50 KiB", () => {
  // POSIX-only: easier to generate a large output portably.
  it("renders head + omitted-notice + tail when output is huge", { skip: isWin }, async () => {
    const sid = freshSession();
    // Generate ~120KB of output: 60000 lines of 2-char content.
    const cmd = "yes x | head -n 60000";
    const out = await invoke("bash", {
      action: "exec",
      command: cmd,
      session: sid,
      timeout_ms: 5000,
    });
    assert.match(out.content, /characters omitted/);
    // The total rendered body shouldn't exceed the cap by much
    // (the cap is the OUTPUT contents — there's still an exit-code
    // line and the omission notice itself).
    assert.ok(
      out.content.length < 70_000,
      `expected truncated body, got ${out.content.length} chars`,
    );
  });
});

// ─── unknown action ─────────────────────────────────────────────────────────

describe("bash — schema enforcement", () => {
  it("returns an error for unknown actions", async () => {
    const out = await invoke("bash", { action: "explode", session: freshSession() });
    assert.equal(out.error, "unknown action");
  });

  it("send requires input", async () => {
    const sid = freshSession();
    await invoke("bash", { action: "exec", command: "echo init", session: sid });
    const out = await invoke("bash", { action: "send", session: sid });
    assert.equal(out.error, "missing input");
  });
});

// ─── exec: command-end edge cases (regression: heredoc + trailing comment) ─

describe("bash — exec terminator placement (heredoc / comment safety)", () => {
  // History: the POSIX launch path used to glue the completion sentinel
  // onto the command via `;`:  `${command}; echo "MARKER:$?"`.
  // That breaks any command whose last line is a heredoc delimiter or a
  // trailing comment — `EOF;` is not a valid heredoc terminator, and
  // `# comment; echo ...` makes the sentinel part of the comment.
  // The sentinel now goes on its OWN line; these tests pin that.

  it("heredoc with quoted delimiter completes (no hang) and writes the file", async (t) => {
    if (isWin) {
      t.skip("heredoc is a POSIX-shell construct");
      return;
    }
    const sid = freshSession();
    const target = join(tmp, "heredoc-out.txt");
    const cmd = `cat > ${target} << 'HUKO_DOC_EOF'\nfirst line\nsecond line with \`backticks\`\nHUKO_DOC_EOF`;
    const out = await invoke("bash", {
      action: "exec",
      command: cmd,
      session: sid,
      timeout_ms: 5000,
    });
    assert.equal(out.error, undefined);
    assert.match(out.content, /\[exit code: 0\]/);
    // Sentinel finished, no timeout note appended.
    assert.doesNotMatch(out.content, /timed out/);
    // The heredoc body actually made it into the file.
    const written = (await import("node:fs/promises")).readFile(target, "utf8");
    assert.match(await written, /first line/);
    assert.match(await written, /second line with `backticks`/);
  });

  it("trailing # comment doesn't swallow the sentinel", async (t) => {
    if (isWin) {
      t.skip("# is not a comment in cmd.exe");
      return;
    }
    const out = await invoke("bash", {
      action: "exec",
      command: "echo before-comment # trailing comment",
      session: freshSession(),
      timeout_ms: 5000,
    });
    assert.equal(out.error, undefined);
    assert.match(out.content, /before-comment/);
    assert.match(out.content, /\[exit code: 0\]/);
    assert.doesNotMatch(out.content, /timed out/);
  });
});

// ─── helper ─────────────────────────────────────────────────────────────────

async function invoke(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; error?: string; metadata?: Record<string, unknown> }> {
  const tool = getTool(name);
  if (!tool || tool.kind !== "server") throw new Error(`tool ${name} not registered`);
  const r = await Promise.resolve(tool.handler(args, stubCtx, { toolCallId: "test" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) {
    const out: { content: string; error?: string; metadata?: Record<string, unknown> } = {
      content: r.content,
    };
    if ("error" in r && r.error) out.error = r.error;
    if ("metadata" in r) out.metadata = r.metadata;
    return out;
  }
  return { content: r.result, ...(r.error ? { error: r.error } : {}) };
}

// Suppress unused: writeFileSync is occasionally handy in ad-hoc test additions.
void writeFileSync;
