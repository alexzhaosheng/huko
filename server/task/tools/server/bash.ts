/**
 * Tool: bash
 *
 * Execute shell commands in a persistent session. The session is a
 * long-lived child process that holds onto its working directory,
 * environment variables, and any exported state across `exec` calls
 * — so a `cd src && pnpm test` flow doesn't have to be one mega
 * command.
 *
 * Cross-platform shell selection happens automatically:
 *   - Windows: %COMSPEC% (cmd.exe by default)
 *   - POSIX:   $SHELL (or /bin/bash if unset)
 *
 * Action verbs (mirror tmux / WeavesAI semantics):
 *   - exec : run a command, wait for it to finish, return output
 *   - send : write raw text to stdin (for interactive prompts, REPLs)
 *   - wait : block until more output arrives or the process exits
 *   - kill : terminate the session's process
 *   - view : peek at any output buffered since the last call
 *
 * Sessions:
 *   - Identified by `session` (default `"default"`).
 *   - Created on first use, reused after.
 *   - Auto-recreated if the underlying process exited.
 *   - Idle cleanup: 30 minutes since last activity → destroy.
 *
 * Exec mechanics:
 *   - We append a sentinel marker to the user's command so we can tell
 *     when it finished AND what its exit code was. The marker line is
 *     stripped from the returned output.
 *   - `timeout_ms` is an IDLE timeout — we return "still running" only
 *     when no stdout/stderr has arrived for that long. Streaming
 *     commands (nested huko, wget, build tools) keep resetting it via
 *     `lastActivity` updates in the chunk handlers, so they don't
 *     trip on slow-but-progressing work. A silent-and-stuck command
 *     still trips at `idleMs`.
 *   - `total_timeout_ms` (optional) is a hard ceiling on total elapsed
 *     time, applied even when output is flowing. Off by default.
 *   - On EITHER timeout the command itself is NOT killed — it keeps
 *     running in the session, and a follow-up `wait` or `view` can
 *     collect the late output. `kill` is the only path that actually
 *     terminates the process.
 *
 * Output:
 *   - Capped at 50 KiB per call. Larger output is rendered as
 *     head (40 KiB) + `[N characters omitted]` + tail (8 KiB).
 *   - Exit code is appended on `[exit code: N]\n` so the LLM can
 *     branch on success/failure.
 *
 * Encoding (Windows CJK-locale users):
 *   - We don't run `chcp 65001` (it breaks stdin pipe-mode echo for
 *     multi-byte characters). Instead we leave cmd at the system ANSI
 *     code page and translate at the boundaries — see _shell-encoding.ts.
 *   - First thing we send to cmd.exe is `@echo off` to suppress the
 *     command-line echo (which would be ANSI-encoded and mangle output
 *     when mixed with UTF-8 from tools like git).
 */

import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";
import {
  decodeShellOutput,
  encodeShellInput,
} from "./_shell-encoding.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 min — even patient users shouldn't wait longer
const OUTPUT_CAP_BYTES = 50_000; // 50 KiB
const OUTPUT_HEAD_KEEP = 40_000;
const OUTPUT_TAIL_KEEP = 8_000;
const SESSION_IDLE_MS = 30 * 60_000; // 30 min
const SESSION_SWEEP_MS = 60_000; // sweep idle sessions every minute

// ─── Session state ───────────────────────────────────────────────────────────

type Session = {
  id: string;
  child: ChildProcess;
  /** Decoded stdout accumulated since last drain. */
  stdoutBuf: string;
  /** Decoded stderr accumulated since last drain. */
  stderrBuf: string;
  exited: boolean;
  exitCode: number | null;
  /** Last time anything happened on this session, for idle cleanup. */
  lastActivity: number;
  /**
   * Pending wait/exec promises register here so streaming chunks can
   * wake them up immediately rather than via the 100ms poll.
   */
  notifyChange: (() => void) | null;
};

const sessions = new Map<string, Session>();

// One sweeper per process, started lazily on first session use to
// avoid keeping the event loop alive in tests / short-lived runs.
let sweeperTimer: NodeJS.Timeout | null = null;
function ensureSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastActivity > SESSION_IDLE_MS) {
        // Fire-and-forget; the sweeper itself doesn't need to await.
        void destroySession(id);
      }
    }
    if (sessions.size === 0) {
      // Nothing to do — let the timer clear so process can exit.
      if (sweeperTimer) clearInterval(sweeperTimer);
      sweeperTimer = null;
    }
  }, SESSION_SWEEP_MS);
  // Don't pin the event loop just for the sweeper.
  sweeperTimer.unref?.();
}

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env["COMSPEC"] ?? "cmd.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}

function createSession(id: string, cwd: string | undefined): Session {
  const shell = getDefaultShell();
  const wd = cwd ?? process.cwd();
  // Make sure the cwd exists; otherwise spawn fails with ENOENT
  // pointing at the shell binary, which is a confusing error.
  try {
    mkdirSync(wd, { recursive: true });
  } catch {
    /* permission etc — let spawn surface the error */
  }
  const isWin = process.platform === "win32";
  const child = spawn(shell, [], {
    cwd: wd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // On Windows we don't want the OS shell semantics; we want the
    // raw cmd.exe child so we control its stdin protocol.
    ...(isWin ? { shell: false, windowsHide: true } : {}),
  });

  const session: Session = {
    id,
    child,
    stdoutBuf: "",
    stderrBuf: "",
    exited: false,
    exitCode: null,
    lastActivity: Date.now(),
    notifyChange: null,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    session.stdoutBuf += decodeShellOutput(chunk);
    session.lastActivity = Date.now();
    session.notifyChange?.();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    session.stderrBuf += decodeShellOutput(chunk);
    session.lastActivity = Date.now();
    session.notifyChange?.();
  });
  child.on("exit", (code) => {
    session.exited = true;
    session.exitCode = code;
    session.notifyChange?.();
  });
  child.on("error", (err) => {
    session.stderrBuf += `[shell error] ${err.message}\n`;
    session.exited = true;
    session.notifyChange?.();
  });

  // Suppress Windows cmd.exe's command echo. Without this every
  // command we send (including the marker echo) gets mirrored back
  // through stdout in ANSI encoding, and untangling the user's real
  // output from the echo is a nightmare when tools like git mix in
  // UTF-8.
  if (isWin) {
    writeStdin(child, "@echo off\r\n");
  }

  sessions.set(id, session);
  ensureSweeper();
  return session;
}

function getOrCreateSession(id: string, cwd: string | undefined): Session {
  let s = sessions.get(id);
  // Auto-recreate if previous incarnation exited (e.g. user ran `exit`).
  if (s && s.exited) {
    sessions.delete(id);
    s = undefined;
  }
  if (!s) s = createSession(id, cwd);
  s.lastActivity = Date.now();
  return s;
}

async function destroySession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  // Remove from the map IMMEDIATELY — concurrent calls on the same
  // session id will see "no session" and create a fresh one rather
  // than racing against the dying child. The actual kill+wait happens
  // on the OLD child reference held in `s`.
  sessions.delete(id);
  if (s.exited) return;

  const exited = new Promise<void>((resolve) => {
    s.child.once("exit", () => resolve());
  });
  try {
    s.child.kill("SIGTERM");
    // Grace period, then force.
    const t = setTimeout(() => {
      try {
        s.child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 2000);
    t.unref?.();
  } catch {
    /* race: process exited between the check and the kill */
  }
  // Wait for actual process exit so the OS releases its handles
  // (cwd, stdio pipes) before our caller does file ops on those
  // paths. Hard cap at 3s so we don't hang forever on a stuck child.
  await Promise.race([
    exited,
    new Promise<void>((r) => {
      const t = setTimeout(r, 3000);
      t.unref?.();
    }),
  ]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeStdin(child: ChildProcess, text: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  child.stdin.write(encodeShellInput(text));
}

function drain(s: Session): { stdout: string; stderr: string } {
  const stdout = s.stdoutBuf;
  const stderr = s.stderrBuf;
  s.stdoutBuf = "";
  s.stderrBuf = "";
  return { stdout, stderr };
}

/** Render output with a head-tail cap. */
function renderOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  let body = "";
  if (stdout) body += stdout;
  if (stderr) {
    body += body ? "\n[stderr]\n" : "[stderr]\n";
    body += stderr;
  }
  if (!body) body = "(no output)";
  if (exitCode !== null) {
    body += `\n[exit code: ${exitCode}]`;
  }

  if (body.length > OUTPUT_CAP_BYTES) {
    const head = body.slice(0, OUTPUT_HEAD_KEEP);
    const tail = body.slice(-OUTPUT_TAIL_KEEP);
    const omitted = body.length - OUTPUT_HEAD_KEEP - OUTPUT_TAIL_KEEP;
    body = `${head}\n\n...(${omitted} characters omitted)...\n\n${tail}`;
  }
  return body;
}

function clampTimeout(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

/** Like clampTimeout but returns undefined for unset / invalid (the "no cap" signal). */
function clampOptionalTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return Math.min(n, MAX_TIMEOUT_MS);
}

// ─── Action: exec ────────────────────────────────────────────────────────────

async function actionExec(
  s: Session,
  command: string,
  idleMs: number,
  totalMs: number | undefined,
): Promise<{ output: string; timedOut: boolean; exitCode: number | null }> {
  // Drain any leftover output from before this exec — we only want
  // output produced BY this command in the result.
  s.stdoutBuf = "";
  s.stderrBuf = "";

  // Append a unique marker so we can detect command completion AND
  // capture the exit code. POSIX uses $?; Windows cmd uses %ERRORLEVEL%.
  //
  // The sentinel MUST go on a NEW LINE, not after a `;` — otherwise a
  // command ending in a heredoc delimiter (e.g. `cat << 'EOF'\n…\nEOF`)
  // gets the sentinel glued onto the EOF line, which then doesn't match
  // bash's "delimiter alone on its line" requirement. The heredoc never
  // terminates, cat blocks reading stdin, and we time out. Same trap
  // exists for a command ending in `# comment` — the sentinel would be
  // commented out. Windows already uses CRLF here; this is the POSIX fix.
  const marker = `__HUKO_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  const launch =
    process.platform === "win32"
      ? `${command}\r\necho ${marker}:%ERRORLEVEL%\r\n`
      : `${command}\necho "${marker}:$?"\n`;
  writeStdin(s.child, launch);

  const markerRegex = new RegExp(`${marker}:(\\d+)`);
  const start = Date.now();
  // Reset the idle clock to NOW so a command that's silent from the
  // start still trips after `idleMs` (otherwise stale activity from
  // before this exec would suppress the first idle window). Subsequent
  // chunk arrivals keep updating `lastActivity` in the data handlers
  // installed by createSession().
  s.lastActivity = start;

  return new Promise((resolve) => {
    const tick = (): void => {
      // Marker visible → command finished.
      const m = markerRegex.exec(s.stdoutBuf);
      if (m) {
        const exitCode = parseInt(m[1]!, 10);
        // Strip both the echo command we wrote AND the marker line
        // itself from the output the user sees.
        const cleaned = s.stdoutBuf
          .replace(new RegExp(`(?:^|\\n).*echo[^\\n]*${marker}[^\\n]*\\r?\\n?`, "g"), "")
          .replace(markerRegex, "")
          .replace(marker, "")
          .replace(/\r?\n$/, "");
        const stderr = s.stderrBuf;
        s.stdoutBuf = "";
        s.stderrBuf = "";
        s.notifyChange = null;
        resolve({
          output: renderOutput(cleaned, stderr, exitCode),
          timedOut: false,
          exitCode,
        });
        return;
      }
      // Process exited without the marker landing — unusual but
      // possible (shell crashed). Surface what we have.
      if (s.exited) {
        const { stdout, stderr } = drain(s);
        s.notifyChange = null;
        resolve({
          output: renderOutput(stdout, stderr, s.exitCode),
          timedOut: false,
          exitCode: s.exitCode,
        });
        return;
      }
      // Timed out → resolve with what we have. The command keeps
      // running; user can `wait` or `view` to pick up the rest.
      //
      // Two timeout flavours, checked in priority order:
      //   1. IDLE — no stdout/stderr for `idleMs`. The default. A
      //      streaming command (nested huko, wget, tsc --watch) keeps
      //      resetting `lastActivity` in the data handlers and never
      //      trips this. A silent command (LLM thinking, `sleep`,
      //      blocked on stdin) does.
      //   2. TOTAL (optional) — hard cap on elapsed time regardless of
      //      output. Off by default; the operator opts in via
      //      `total_timeout_ms` when they want a strict ceiling.
      const now = Date.now();
      if (now - s.lastActivity >= idleMs) {
        const { stdout, stderr } = drain(s);
        s.notifyChange = null;
        const note = `[idle timeout — no output for ${idleMs}ms; command still running in this session; use action=wait or action=view to collect more output, or action=kill to abort]`;
        resolve({
          output: renderOutput(stdout + (stdout && !stdout.endsWith("\n") ? "\n" : "") + note, stderr, null),
          timedOut: true,
          exitCode: null,
        });
        return;
      }
      if (totalMs !== undefined && now - start >= totalMs) {
        const { stdout, stderr } = drain(s);
        s.notifyChange = null;
        const note = `[total timeout — exceeded ${totalMs}ms; command still running in this session; use action=wait or action=view to collect more output, or action=kill to abort]`;
        resolve({
          output: renderOutput(stdout + (stdout && !stdout.endsWith("\n") ? "\n" : "") + note, stderr, null),
          timedOut: true,
          exitCode: null,
        });
        return;
      }
      // Otherwise keep polling. notifyChange wakes us early when new
      // chunks arrive; the setTimeout is the upper bound.
      pending = setTimeout(tick, 100);
      pending.unref?.();
    };
    let pending: NodeJS.Timeout | null = null;
    s.notifyChange = () => {
      if (pending) clearTimeout(pending);
      // Re-poll on next microtask so the buffer has the chunk applied.
      queueMicrotask(tick);
    };
    tick();
  });
}

// ─── Action: send ────────────────────────────────────────────────────────────

function actionSend(s: Session, input: string): string {
  if (s.exited) {
    return "[error] Shell process has exited. Run `action=exec` to start a new one (the session will be recreated).";
  }
  writeStdin(s.child, input);
  return "(sent — call action=wait or action=view to read the response)";
}

// ─── Action: wait ────────────────────────────────────────────────────────────

async function actionWait(s: Session, timeoutMs: number): Promise<string> {
  // Output that arrived before we were asked to wait still counts.
  const carryover = drain(s);
  if (s.exited) {
    return renderOutput(carryover.stdout, carryover.stderr, s.exitCode);
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
    s.notifyChange = () => {
      clearTimeout(t);
      s.notifyChange = null;
      resolve();
    };
  });
  const fresh = drain(s);
  return renderOutput(
    carryover.stdout + fresh.stdout,
    carryover.stderr + fresh.stderr,
    s.exited ? s.exitCode : null,
  );
}

// ─── Action: kill ────────────────────────────────────────────────────────────

async function actionKill(id: string): Promise<string> {
  const s = sessions.get(id);
  if (!s) return `Session "${id}" not found.`;
  if (s.exited) {
    sessions.delete(id);
    return `Session "${id}" was already exited (code ${s.exitCode}); cleaned up.`;
  }
  await destroySession(id);
  return `Session "${id}" terminated.`;
}

// ─── Action: view ────────────────────────────────────────────────────────────

function actionView(s: Session): string {
  const { stdout, stderr } = drain(s);
  return renderOutput(stdout, stderr, s.exited ? s.exitCode : null);
}

// ─── Tool registration ──────────────────────────────────────────────────────

// Base description shared by all platforms. The `<platform>` block was
// removed: platform-specific guidance now lives in `platformNotes` so
// the registry appends it only on the runtime that needs it (Windows).
// On Linux/Mac the LLM never sees Windows shell rules — direct -190 tok.
//
// Trims vs. the previous version (preserving behavior-shaping content):
//   - `<limits>` head/tail mechanics + idle-reap dropped (engine detail)
//   - `<sessions>` "auto-recreate fresh session" wording dropped (engine fallback)
//   - `<actions>` `kill` SIGTERM/SIGKILL signal detail dropped
//   - `<actions>` `view` description tightened
//   - "use `write_file` to write a cross-platform script" advice dropped
//     (rarely followed; tempts the LLM to produce stray script files)
const DESCRIPTION =
  "Run a shell command in a persistent session. The session preserves cwd, env vars, and exported state across calls — `cd src` then later `pnpm test` works as expected.\n\n" +
  "<actions>\n" +
  "- `exec`  (default): run `command`, wait for it to finish, return output + exit code.\n" +
  "- `send`           : write raw `input` text to the session's stdin (e.g. answering an interactive prompt). The shell does NOT auto-add a newline — include `\\n` yourself if you want one.\n" +
  "- `wait`           : block until more output arrives or the process exits. Useful after `send`.\n" +
  "- `kill`           : terminate the session's process.\n" +
  "- `view`           : drain output buffered since the last call.\n" +
  "</actions>\n\n" +
  "<sessions>\n" +
  "Sessions are keyed by `session` (default `\"default\"`). Use a different `session` id to run commands in parallel (e.g. a long-running dev server in `\"dev\"` while you keep working in `\"default\"`).\n" +
  "</sessions>\n\n" +
  "<limits>\n" +
  "- Output is capped at ~50 KiB per call (larger output is truncated).\n" +
  "- `timeout_ms` (default 30000, max 300000) is an IDLE timeout — we return \"still running\" only when no stdout/stderr has arrived for that long. Streaming commands (nested agents, builds, downloads) keep resetting it; only silent-and-stuck commands trip. The command keeps running in the session either way; use `wait` / `view` / `kill` to follow up.\n" +
  "- `total_timeout_ms` (optional, off by default) is a hard ceiling on TOTAL elapsed time even when output is flowing. Use only when you want a strict cap (e.g. capping a pathological build).\n" +
  "</limits>\n\n" +
  "<instructions>\n" +
  "- Prefer non-interactive flags (`--yes`, `--no-input`, `-y`). Interactive prompts that expect a TTY may hang — use `send` to feed responses, or pipe an answer in with `yes |`.\n" +
  "- Don't run installers or commands that require sudo / elevation in the middle of a task — they'll hang waiting for a password.\n" +
  "- Use `cwd` ONLY when CREATING a new session. Once the shell is running, `cd` inside it instead.\n" +
  "</instructions>";

// Windows-only addendum, appended by the registry when process.platform
// === "win32". Linux/Mac runtimes never see this text. The pithy form
// covers the four commands LLMs trip on most under cmd.exe.
const WIN_PLATFORM_NOTE =
  "<platform>\n" +
  "- Shell is cmd.exe by default. Use `dir` not `ls`, `type` not `cat`, `set` not `export`.\n" +
  "- PowerShell is reachable via `powershell -Command \"...\"`.\n" +
  "</platform>";

// Lean-mode replacement description. Drops advanced-workflow guidance
// (sessions, send/wait/kill/view, output-cap mechanics, idle-reap) that
// a single-shot lean user case won't exercise. Keeps the bits without
// which the LLM reliably misfires: non-interactive flag preference,
// sudo avoidance, Windows shell differences.
//
// Size: ~420 chars vs. ~3000 for the default — ~85% smaller.
const LEAN_DESCRIPTION =
  "Run a shell command and return its stdout/stderr + exit code. " +
  "The shell session preserves cwd and env across calls, so `cd foo` then later `ls` works.\n\n" +
  "- `timeout_ms` (default 30s, max 300s) is an idle timeout — silent-for-that-long commands return \"still running\" but keep running in the session.\n" +
  "- Output capped at ~50 KiB.\n" +
  "- Prefer non-interactive flags (`-y`, `--yes`). Avoid sudo / interactive prompts — they hang.\n" +
  "- On Windows the shell is cmd.exe: use `dir` / `type` / `set` instead of `ls` / `cat` / `export`.";

registerServerTool(
  {
    name: "bash",
    description: DESCRIPTION,
    leanDescription: LEAN_DESCRIPTION,
    platformNotes: {
      win32: WIN_PLATFORM_NOTE,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["exec", "send", "wait", "kill", "view"],
          description: "Default `exec`.",
        },
        command: {
          type: "string",
          description: "Required for `exec`. The shell command to run.",
        },
        input: {
          type: "string",
          description: "Required for `send`. Raw text written to stdin.",
        },
        session: {
          type: "string",
          description: "Session id. Defaults to `default`.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory. Only honoured when CREATING a new session; ignored on subsequent calls (use `cd` inside the shell instead).",
        },
        timeout_ms: {
          type: "number",
          description: `IDLE timeout — return "still running" if no stdout/stderr arrives within this many ms. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Streaming commands (nested huko, wget, build tools) keep resetting it; only silent-and-stuck commands trip.`,
        },
        total_timeout_ms: {
          type: "number",
          description: `Optional HARD CAP on total elapsed time, even when output is flowing. Off by default. Use only when you want a strict ceiling regardless of activity (e.g. capping a pathological build at 5 min).`,
        },
      },
      required: [],
    },
    dangerLevel: "dangerous",
  },
  async (args): Promise<ToolHandlerResult> => {
    const action = String(args["action"] ?? "exec");
    const sessionId = String(args["session"] ?? "default");
    const cwd =
      typeof args["cwd"] === "string" && args["cwd"].trim() !== ""
        ? path.resolve(String(args["cwd"]))
        : undefined;
    const timeoutMs = clampTimeout(args["timeout_ms"]);
    const totalTimeoutMs = clampOptionalTimeout(args["total_timeout_ms"]);

    switch (action) {
      case "exec": {
        const command = args["command"];
        if (typeof command !== "string" || command === "") {
          return {
            content: "Error: `command` is required for action=exec.",
            error: "missing command",
          };
        }
        const s = getOrCreateSession(sessionId, cwd);
        const r = await actionExec(s, command, timeoutMs, totalTimeoutMs);
        return {
          content: r.output,
          summary: `bash exec (session=${sessionId}${r.timedOut ? ", timeout" : `, exit=${r.exitCode}`})`,
          metadata: {
            action: "exec",
            session: sessionId,
            command,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
          },
        };
      }

      case "send": {
        const input = args["input"];
        if (typeof input !== "string") {
          return {
            content: "Error: `input` is required for action=send.",
            error: "missing input",
          };
        }
        const s = getOrCreateSession(sessionId, cwd);
        return {
          content: actionSend(s, input),
          summary: `bash send (session=${sessionId})`,
          metadata: { action: "send", session: sessionId, length: input.length },
        };
      }

      case "wait": {
        const s = sessions.get(sessionId);
        if (!s) {
          return {
            content: `Session "${sessionId}" not found. Run \`action=exec\` first to start one.`,
            summary: `bash wait (session=${sessionId}, no session)`,
          };
        }
        const out = await actionWait(s, timeoutMs);
        return {
          content: out,
          summary: `bash wait (session=${sessionId})`,
          metadata: { action: "wait", session: sessionId, exited: s.exited },
        };
      }

      case "kill": {
        return {
          content: await actionKill(sessionId),
          summary: `bash kill (session=${sessionId})`,
          metadata: { action: "kill", session: sessionId },
        };
      }

      case "view": {
        const s = sessions.get(sessionId);
        if (!s) {
          return {
            content: `Session "${sessionId}" not found.`,
            summary: `bash view (session=${sessionId}, no session)`,
          };
        }
        return {
          content: actionView(s),
          summary: `bash view (session=${sessionId})`,
          metadata: { action: "view", session: sessionId, exited: s.exited },
        };
      }

      default:
        return {
          content: `Error: unknown action "${action}". Allowed: exec | send | wait | kill | view.`,
          error: "unknown action",
        };
    }
  },
);

/**
 * Cleanup hook: destroy all live sessions. Useful for graceful
 * shutdown (CLI exit, daemon stop). Tests also call this between
 * suites to keep state clean.
 */
export async function destroyAllBashSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => destroySession(id)));
}
