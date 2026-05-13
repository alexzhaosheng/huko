/**
 * server/task/tools/server/browser-session.ts
 *
 * Manages the CDP connection to the user's Chrome browser.
 * Connects to a running Chrome instance with --remote-debugging-port,
 * reuses the connection across tool calls, and auto-disconnects
 * after idle timeout.
 *
 * Uses puppeteer-core as a dynamic import — the package is an optional
 * peer dependency. If not installed, the first call to any browser
 * function returns a clear setup instruction.
 */

import { getConfig } from "../../../config/index.js";

// ─── Tunables ────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60_000; // 30 min
const SWEEP_INTERVAL_MS = 60_000;

// ─── Dynamic import for optional dependency ─────────────────────────────────
// We keep puppeteer-core as a dynamic import so the tool can self-register
// without crashing when it's missing. The first connect() call loads it.

type PuppeteerModule = typeof import("puppeteer-core");

let pu: PuppeteerModule | null = null;

async function loadPuppeteer(): Promise<PuppeteerModule> {
  if (pu) return pu;
  try {
    pu = await import("puppeteer-core");
    return pu;
  } catch {
    throw new Error(
      "puppeteer-core is not installed. Run:\n" +
      "  npm install puppeteer-core\n" +
      "Then start Chrome with:\n" +
      "  chrome --remote-debugging-port=9222",
    );
  }
}

// ─── Session state ───────────────────────────────────────────────────────────

type BrowserSession = {
  browser: Awaited<ReturnType<PuppeteerModule["connect"]>>;
  pages: Awaited<ReturnType<Awaited<ReturnType<PuppeteerModule["connect"]>>["pages"]>>;
  activePageIndex: number;
  lastActivity: number;
};

let session: BrowserSession | null = null;

// Sweeper timer
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    if (!session) {
      if (sweeperTimer) clearInterval(sweeperTimer);
      sweeperTimer = null;
      return;
    }
    if (Date.now() - session.lastActivity > IDLE_TIMEOUT_MS) {
      void disconnect();
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeperTimer.unref === "function") sweeperTimer.unref();
}

// ─── Connection ─────────────────────────────────────────────────────────────

async function connect(): Promise<BrowserSession> {
  if (session) {
    session.lastActivity = Date.now();
    return session;
  }

  const puppeteer = await loadPuppeteer();
  const cfg = getConfig().tools.browser;
  const browserURL = `http://${cfg.cdpHost}:${cfg.cdpPort}`;

  let browser: BrowserSession["browser"];
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    browser = await puppeteer.connect({
      browserURL,
      // Omit defaultViewport — use the user's actual window size.
    } as unknown as Parameters<typeof puppeteer.connect>[0]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to Chrome at ${browserURL}.\n` +
      `${msg}\n\n` +
      `Make sure Chrome is running with remote debugging enabled:\n` +
      `  chrome --remote-debugging-port=${cfg.cdpPort}\n` +
      `Or configure a different port with:\n` +
      `  huko config set tools.browser.cdpPort 9223`,
    );
  }

  const pages = await browser.pages();
  const activePageIndex = pages.length > 0 ? pages.length - 1 : 0;

  session = {
    browser,
    pages,
    activePageIndex,
    lastActivity: Date.now(),
  };

  ensureSweeper();

  browser.on("disconnected", () => {
    session = null;
  });

  return session;
}

export async function disconnect(): Promise<void> {
  if (!session) return;
  try {
    await session.browser.disconnect();
  } catch {
    /* best-effort */
  }
  session = null;
}

// ─── Page management ────────────────────────────────────────────────────────

type Page = Awaited<ReturnType<BrowserSession["browser"]["newPage"]>>;

async function getActivePage(): Promise<Page> {
  const s = await connect();
  if (s.pages.length === 0) {
    const page = await s.browser.newPage();
    s.pages.push(page);
    s.activePageIndex = s.pages.length - 1;
    return page;
  }
  s.pages = await s.browser.pages();
  if (s.activePageIndex >= s.pages.length) {
    s.activePageIndex = s.pages.length - 1;
  }
  const page = s.pages[s.activePageIndex];
  if (!page) {
    const newPage = await s.browser.newPage();
    s.pages.push(newPage);
    s.activePageIndex = s.pages.length - 1;
    return newPage;
  }
  try {
    await page.bringToFront();
  } catch {
    s.pages = await s.browser.pages();
    s.activePageIndex = s.pages.length - 1;
    const fallback = s.pages[s.activePageIndex];
    if (!fallback) throw new Error("no open pages");
    return fallback;
  }
  return page;
}

// ─── Exported helpers ───────────────────────────────────────────────────────

// All page.evaluate() calls use raw strings to avoid depending on DOM types
// in the kernel tsconfig (architecture principle: no DOM in kernel).

/**
 * Navigate the active page to a URL and return the visible text content.
 */
export async function browserNavigate(url: string): Promise<string> {
  const s = await connect();
  const cfg = getConfig().tools.browser;

  const page = await s.browser.newPage();
  s.pages.push(page);
  s.activePageIndex = s.pages.length - 1;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).goto(url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.defaultTimeoutMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Navigation to ${url} failed: ${msg}`;
  }

  s.lastActivity = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return await (page as any).evaluate("document.body ? document.body.innerText : document.documentElement.innerText");
  } catch {
    return "(page loaded but content could not be extracted)";
  }
}

/**
 * Click the first element matching a CSS selector.
 */
export async function browserClick(selector: string): Promise<string> {
  const page = await getActivePage();
  const cfg = getConfig().tools.browser;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).waitForSelector(selector, { timeout: cfg.defaultTimeoutMs });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).click(selector);
    if (session) session.lastActivity = Date.now();
    return `Clicked element "${selector}".`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Click failed: ${msg}`;
  }
}

/**
 * Type text into an input matching a CSS selector.
 */
export async function browserType(selector: string, text: string): Promise<string> {
  const page = await getActivePage();
  const cfg = getConfig().tools.browser;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).waitForSelector(selector, { timeout: cfg.defaultTimeoutMs });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).focus(selector);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await (page as any).keyboard.type(text);
    if (session) session.lastActivity = Date.now();
    return `Typed "${text}" into "${selector}".`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Type failed: ${msg}`;
  }
}

/**
 * Scroll the active page.
 */
export async function browserScroll(direction: string): Promise<string> {
  const page = await getActivePage();
  try {
    switch (direction) {
      case "down":
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (page as any).evaluate("window.scrollBy(0, 300)");
        break;
      case "up":
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (page as any).evaluate("window.scrollBy(0, -300)");
        break;
      case "top":
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (page as any).evaluate("window.scrollTo(0, 0)");
        break;
      case "bottom":
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (page as any).evaluate("window.scrollTo(0, document.body.scrollHeight)");
        break;
      default:
        return `Unknown scroll direction: "${direction}". Use: up, down, top, bottom.`;
    }
    if (session) session.lastActivity = Date.now();
    return `Scrolled ${direction}.`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Scroll failed: ${msg}`;
  }
}

/**
 * Return the visible text content of the active page.
 */
export async function browserGetText(): Promise<string> {
  const page = await getActivePage();
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    const text: string = await (page as any).evaluate(
      "document.body ? document.body.innerText : document.documentElement.innerText",
    );
    return text.length > 0 ? text : "(page has no visible text)";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Get text failed: ${msg}`;
  }
}

/**
 * Return the full HTML source of the active page.
 */
export async function browserGetHtml(): Promise<string> {
  const page = await getActivePage();
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    const html: string = await (page as any).evaluate(
      "document.documentElement.outerHTML",
    );
    const maxBytes = getConfig().tools.browser.maxScreenshotBytes;
    if (html.length > maxBytes) {
      return html.slice(0, maxBytes) +
        `\n\n[truncated at ${maxBytes} bytes, total: ${html.length}]`;
    }
    return html;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Get HTML failed: ${msg}`;
  }
}

/**
 * Take a screenshot and return it as a Buffer + suggested filename.
 */
export async function browserScreenshot(
  selector?: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const page = await getActivePage();
  const cfg = getConfig().tools.browser;

  let buffer: Buffer;
  if (selector) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const element = await (page as any).$(selector);
    if (!element) throw new Error(`Element "${selector}" not found.`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const box = await (element as any).boundingBox();
    if (!box) throw new Error(`Element "${selector}" has no bounding box.`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    buffer = Buffer.from(await (page as any).screenshot({ clip: box, type: "png" }));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    buffer = Buffer.from(await (page as any).screenshot({ type: "png" }));
  }

  if (buffer.length > cfg.maxScreenshotBytes) {
    throw new Error(
      `Screenshot too large: ${buffer.length} bytes (max ${cfg.maxScreenshotBytes}).`,
    );
  }

  if (session) session.lastActivity = Date.now();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    buffer,
    filename: `screenshot-${timestamp}.png`,
  };
}

/**
 * Wait for a selector to appear or for a specified number of milliseconds.
 */
export async function browserWait(
  selector?: string,
  ms?: number,
): Promise<string> {
  const page = await getActivePage();
  const cfg = getConfig().tools.browser;
  try {
    if (selector) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (page as any).waitForSelector(selector, { timeout: cfg.defaultTimeoutMs });
      return `Element "${selector}" appeared.`;
    }
    if (ms !== undefined && ms > 0) {
      await new Promise((r) => setTimeout(r, Math.min(ms, 30_000)));
      return `Waited ${ms}ms.`;
    }
    return "Wait requires either a selector or ms parameter.";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Wait failed: ${msg}`;
  }
}

/**
 * List all open pages (tabs) in the browser.
 */
export async function browserListPages(): Promise<string> {
  const s = await connect();
  s.pages = await s.browser.pages();
  const lines: string[] = [];
  for (let i = 0; i < s.pages.length; i++) {
    const p = s.pages[i];
    if (!p) continue;
    try {
      const url = p.url();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const title: string = await (p as any).title();
      const marker = i === s.activePageIndex ? " *" : "";
      lines.push(`${i}${marker} ${title || "(no title)"}  ${url}`);
    } catch {
      lines.push(`${i} (unavailable)`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no open pages)";
}

/**
 * Switch the active page to the one at the given index.
 */
export async function browserSwitchPage(index: number): Promise<string> {
  const s = await connect();
  s.pages = await s.browser.pages();
  if (index < 0 || index >= s.pages.length) {
    return `Invalid page index ${index}. Valid range: 0-${s.pages.length - 1}.`;
  }
  s.activePageIndex = index;
  const p = s.pages[index];
  if (!p) return `Page ${index} is unavailable.`;
  try {
    await p.bringToFront();
    const url = p.url();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const title: string = await (p as any).title();
    return `Switched to page ${index}: ${title}  ${url}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to switch to page ${index}: ${msg}`;
  }
}
