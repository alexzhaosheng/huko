/**
 * server/task/tools/server/browser-session.ts
 *
 * WebSocket server that a Chrome extension connects to.
 * huko acts as the server — the "browser" feature sidecar starts a WS
 * listener, the extension (installed in the user's browser) connects and
 * executes commands in the user's real Chrome environment.
 *
 * Lifecycle:
 *   - WS server is started by the browser feature's sidecar (chat-mode only).
 *   - Extension connects and stays connected while the sidecar runs.
 *   - Server shuts down when the sidecar's stop() is called (chat exit).
 *   - Tool handlers call sendCommand() which requires the server to already
 *     be running — no lazy start.
 *
 * One-shot `huko -- prompt` never starts sidecars, so browser commands
 * fail with a clear "server not running" message there.
 */

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { getConfig } from "../../../config/index.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS = 30_000;
const WAIT_FOR_CLIENT_MS = 15_000; // wait up to 15s — extension reconnects in <5s
const PING_TIMEOUT_MS = 3_000; // wait up to 3s for pong from client

// ─── Protocol types ──────────────────────────────────────────────────────────

type BrowserCommand =
  | { cmd: "ping" }
  | { cmd: "navigate"; url: string }
  | { cmd: "click"; selector: string }
  | { cmd: "type"; selector: string; text: string }
  | { cmd: "scroll"; direction: string }
  | { cmd: "get_text" }
  | { cmd: "get_html" }
  | { cmd: "screenshot"; selector?: string }
  | { cmd: "wait"; selector?: string; ms?: number }
  | { cmd: "list_pages" }
  | { cmd: "switch_page"; index: number };

type Outgoing = BrowserCommand & { id: number };

type Incoming =
  | { id: number; ok: true; result: string; attachment?: { filename: string; data: string /* base64 */ } }
  | { id: number; ok: false; error: string };

// ─── Server state ────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let client: WebSocket | null = null;
let nextId = 1;

/** pending[id] = { resolve, reject, timer } */
const pending = new Map<
  number,
  {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
    attachment: { value?: { filename: string; data: string } };
    timer: NodeJS.Timeout;
  }
>();

// ─── Server lifecycle ───────────────────────────────────────────────────────

/**
 * Start the WebSocket server. Called by the browser sidecar in chat mode.
 * Idempotent: does nothing if already running.
 */
export async function startServer(): Promise<void> {
  if (wss) return;

  const cfg = getConfig().tools.browser;
  const port = cfg.wsPort;

  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, host: "127.0.0.1" });

    server.on("listening", () => {
      wss = server;
      resolve();
    });

    server.on("error", (err) => {
      reject(
        new Error(
          `Cannot start browser WebSocket server on port ${port}: ${err.message}. ` +
          `Is another process using that port? Change it with:\n` +
          `  huko config set tools.browser.wsPort 19223`,
        ),
      );
    });

    server.on("connection", (ws) => {
      // Only one client at a time — drop previous if any
      if (client) {
        try { client.close(); } catch { /* best-effort */ }
      }
      client = ws;

      ws.on("message", (raw) => {
        let msg: Incoming;
        try {
          msg = JSON.parse(raw.toString()) as Incoming;
        } catch {
          return;
        }
        const entry = pending.get(msg.id);
        if (!entry) return;

        clearTimeout(entry.timer);
        pending.delete(msg.id);

        if (msg.ok) {
          // Capture attachment if present (for screenshot)
          if (msg.attachment) {
            entry.attachment.value = msg.attachment;
          }
          entry.resolve(msg.result);
        } else {
          entry.reject(new Error(msg.error ?? "unknown error"));
        }
      });

      ws.on("close", () => {
        if (client === ws) client = null;
      });
    });
  });
}

/**
 * Stop the WebSocket server and reject all pending commands.
 * Called by the browser sidecar's stop() on chat exit.
 * Idempotent: safe to call multiple times.
 */
export async function stopServer(): Promise<void> {
  // Reject all pending commands
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("browser WebSocket server shut down"));
    pending.delete(id);
  }
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }
  if (wss) {
    try {
      await new Promise<void>((resolve) => {
        wss!.close(() => resolve());
      });
    } catch {
      /* ignore */
    }
    wss = null;
  }
}

// ─── Command dispatch ────────────────────────────────────────────────────────

async function waitForClient(): Promise<void> {
  if (client && client.readyState === 1 /* WebSocket.OPEN */) {
    // Client claims to be connected, but in MV3 the service worker may
    // have been terminated, leaving a zombie TCP connection.  Verify
    // liveness with a ping/pong exchange before trusting it.
    const alive = await pingClient();
    if (alive) return;
    // Zombie detected — close it and wait for a fresh connection.
    try { client!.close(); } catch { /* ignore */ }
    client = null;
  }

  const deadline = Date.now() + WAIT_FOR_CLIENT_MS;
  while (Date.now() < deadline) {
    if (client && client.readyState === 1) {
      const alive = await pingClient();
      if (alive) return;
      try { client!.close(); } catch { /* ignore */ }
      client = null;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const cfg = getConfig().tools.browser;
  throw new Error(
    "Chrome extension did not connect in time.\n" +
    "Make sure the huko browser extension is installed and Chrome is running.\n" +
    `The extension will auto-connect to ws://127.0.0.1:${cfg.wsPort}`,
  );
}

/** Send a ping; return true if the client responds with pong. */
async function pingClient(): Promise<boolean> {
  if (!client || client.readyState !== 1) return false;
  const pingId = nextId++;
  const pongPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    // Use a short-term pending entry to catch the pong
    pending.set(pingId, {
      resolve: () => {
        clearTimeout(timer);
        resolve(true);
      },
      reject: () => {
        clearTimeout(timer);
        resolve(false);
      },
      attachment: {},
      timer,
    });
  });

  try {
    client!.send(JSON.stringify({ id: pingId, cmd: "ping" }));
  } catch {
    pending.delete(pingId);
    return false;
  }

  try {
    return await pongPromise;
  } finally {
    pending.delete(pingId);
  }
}

async function sendCommand(cmd: BrowserCommand): Promise<{
  text: string;
  attachment?: { filename: string; data: string };
}> {
  // Server is expected to be running (started by the sidecar). Fail
  // with a clear message rather than lazy-starting — in one-shot mode
  // there is no sidecar, and the user should be told why.
  if (!wss) {
    throw new Error(
      "Browser WebSocket server is not running. " +
      "The \"browser\" feature must be enabled in chat mode " +
      "(`huko --chat --enable=browser`).",
    );
  }

  await waitForClient();

  const id = nextId++;
  const attachment: { value?: { filename: string; data: string } } = {};

  const outgoing: Outgoing = { id, ...cmd };
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timed out after ${CMD_TIMEOUT_MS}ms: ${cmd.cmd}`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, attachment, timer });
  });

  // waitForClient() guarantees client is non-null and OPEN here
  client!.send(JSON.stringify(outgoing));

  try {
    const text = await promise;
    return {
      text,
      ...(attachment.value ? { attachment: attachment.value } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: `Error: ${msg}`,
      ...(attachment.value ? { attachment: attachment.value } : {}),
    };
  }
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export async function browserNavigate(url: string): Promise<string> {
  const { text } = await sendCommand({ cmd: "navigate", url });
  return text;
}

export async function browserClick(selector: string): Promise<string> {
  const { text } = await sendCommand({ cmd: "click", selector });
  return text;
}

export async function browserType(selector: string, text: string): Promise<string> {
  const { text: result } = await sendCommand({ cmd: "type", selector, text });
  return result;
}

export async function browserScroll(direction: string): Promise<string> {
  const { text } = await sendCommand({ cmd: "scroll", direction });
  return text;
}

export async function browserGetText(): Promise<string> {
  const { text } = await sendCommand({ cmd: "get_text" });
  return text;
}

export async function browserGetHtml(): Promise<string> {
  const { text } = await sendCommand({ cmd: "get_html" });
  return text;
}

export async function browserScreenshot(
  selector?: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const { text, attachment } = await sendCommand({
    cmd: "screenshot",
    ...(selector ? { selector } : {}),
  });
  if (!attachment) {
    throw new Error("Screenshot failed: no image data from extension. " + text);
  }
  return {
    buffer: Buffer.from(attachment.data, "base64"),
    filename: attachment.filename,
  };
}

export async function browserWait(
  selector?: string,
  ms?: number,
): Promise<string> {
  const { text } = await sendCommand({
    cmd: "wait",
    ...(selector ? { selector } : {}),
    ...(ms !== undefined ? { ms } : {}),
  });
  return text;
}

export async function browserListPages(): Promise<string> {
  const { text } = await sendCommand({ cmd: "list_pages" });
  // Extension returns JSON array; parse and format nicely
  try {
    const pages = JSON.parse(text) as Array<{
      index: number;
      url: string;
      title: string;
      active: boolean;
    }>;
    return pages
      .map(
        (p) =>
          `${p.index}${p.active ? " *" : ""} ${p.title || "(no title)"}  ${p.url}`,
      )
      .join("\n");
  } catch {
    return text;
  }
}

export async function browserSwitchPage(index: number): Promise<string> {
  const { text } = await sendCommand({ cmd: "switch_page", index });
  return text;
}
