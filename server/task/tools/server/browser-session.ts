/**
 * server/task/tools/server/browser-session.ts
 *
 * WebSocket server that a Chrome extension connects to.
 * huko acts as the server — it starts a WS listener on demand, the
 * extension (installed in the user's browser) connects and executes
 * commands in the user's real Chrome environment.
 *
 * Lifecycle:
 *   - WS server starts lazily on the first `sendCommand()` call.
 *   - Extension connects and stays connected while huko is running.
 *   - Server shuts down on `disconnect()` (called at session end) or
 *     after 5 min of idle with no connected client.
 */

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { getConfig } from "../../../config/index.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 5 * 60_000; // 5 min idle → close server

// ─── Protocol types ──────────────────────────────────────────────────────────

type BrowserCommand =
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

let idleTimer: NodeJS.Timeout | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void stopServer();
  }, IDLE_CLOSE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

// ─── Server lifecycle ───────────────────────────────────────────────────────

async function ensureServer(): Promise<void> {
  if (wss) {
    resetIdleTimer();
    return;
  }

  const cfg = getConfig().tools.browser;
  const port = cfg.wsPort;

  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port, host: "127.0.0.1" });

    server.on("listening", () => {
      wss = server;
      resetIdleTimer();
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
      resetIdleTimer();

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

async function stopServer(): Promise<void> {
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
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ─── Command dispatch ────────────────────────────────────────────────────────

async function sendCommand(cmd: BrowserCommand): Promise<{
  text: string;
  attachment?: { filename: string; data: string };
}> {
  await ensureServer();

  if (!client || client.readyState !== 1 /* WebSocket.OPEN */) {
    throw new Error(
      "Chrome extension is not connected.\n" +
      "Make sure the huko browser extension is installed and Chrome is running.\n" +
      `The extension will auto-connect to ws://127.0.0.1:${getConfig().tools.browser.wsPort}`,
    );
  }

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

  client.send(JSON.stringify(outgoing));

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

export async function disconnect(): Promise<void> {
  await stopServer();
}

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
