/**
 * Tool: browser
 *
 * Operate the user's real Chrome browser through a lightweight extension.
 * huko's "browser-control" feature sidecar hosts a WebSocket server; the
 * Chrome extension connects and executes commands in the user's real
 * browsing environment. All cookies, logins, and sessions are live.
 *
 * v2 adds AI-powered element finding:
 *   - `find` returns all interactive elements with @e1, @e2 refs
 *   - `click_ref` / `type_ref` target elements by ref
 *   - `navigate` returns a compact element snapshot automatically
 *
 * This tool is gated by the "browser-control" feature (disabled by default).
 * Enable in chat mode:
 *   huko --chat --enable=browser-control
 *
 * Actions:
 *   - navigate    — open a URL in a new tab, return visible page text + element snapshot
 *   - click       — click the first element matching a CSS selector
 *   - type        — type text into an input matching a CSS selector
 *   - scroll      — scroll the active page (up / down / top / bottom)
 *   - get_text    — return the visible text content of the active page
 *   - get_html    — return the full HTML source of the active page
 *   - screenshot  — capture a PNG screenshot, returned as a file attachment
 *   - wait        — wait for a selector to appear or a plain timeout
 *   - list_pages  — list all open tabs (URL + title)
 *   - switch_page — switch the active tab by index
 *   - find        — return all visible interactive elements with @eN refs
 *   - click_ref   — click an element by its @eN ref
 *   - type_ref    — type text into an element by its @eN ref
 *
 * Setup (one-time):
 *   1. Load the extension in Chrome from extensions/chrome/
 *   2. The extension icon shows connection status
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { registerServerTool, type ToolHandlerResult } from "../registry.js";
import {
  browserNavigate,
  browserClick,
  browserType,
  browserScroll,
  browserGetText,
  browserGetHtml,
  browserScreenshot,
  browserWait,
  browserListPages,
  browserSwitchPage,
  browserFind,
  browserClickRef,
  browserTypeRef,
} from "./browser-session.js";

// ─── Description ────────────────────────────────────────────────────────────

const DESCRIPTION =
  "Operate the user's real Chrome browser through a Chrome extension.\n\n" +
  "<action_groups>\n" +
  "**Element refs (v2):** Use `find` to list all interactive elements with @eN refs, then `click_ref` / `type_ref` to interact. Preferred over CSS selectors for dynamic pages.\n\n" +
  "**Classic selectors:** `click` / `type` use CSS selectors. Use when you know the exact selector.\n\n" +
  "</action_groups>\n\n" +
  "<actions>\n" +
  "- `find`        : Return all visible interactive elements with @eN refs (e.g. @e5).\n" +
  "- `click_ref`   : Click an element by its @eN ref from `find`.\n" +
  "- `type_ref`    : Type text into an element by its @eN ref from `find`.\n" +
  "- `navigate`    : Open a URL in a new tab. Returns visible page text + interactive element snapshot.\n" +
  "- `click`       : Click the first element matching a CSS selector.\n" +
  "- `type`        : Type text into an input matching a CSS selector.\n" +
  "- `scroll`      : Scroll the active page (up / down / top / bottom).\n" +
  "- `get_text`    : Return the visible text content of the active page.\n" +
  "- `get_html`    : Return the full HTML source of the active page.\n" +
  "- `screenshot`  : Capture a PNG screenshot (full page or element). Returned as a file attachment.\n" +
  "- `wait`        : Wait for a CSS selector to appear, or a plain timeout in ms.\n" +
  "- `list_pages`  : List all open tabs with URL and title.\n" +
  "- `switch_page` : Switch the active tab by index (from list_pages).\n" +
  "</actions>\n\n" +
  "<instructions>\n" +
  "- **Preferred workflow for dynamic pages:** `find` → pick the right @eN refs → `click_ref` / `type_ref`.\n" +
  "- `find` returns elements in this format: `@e1 button \"Sign In\" @e2 input placeholder=\"Email\"`.\n" +
  "- Choose the ref whose description best matches what the user asked for.\n" +
  "- CSS selectors (`click` / `type`) are brittle on modern SPAs. Prefer ref-based commands.\n" +
  "- `navigate` opens a NEW tab every time — use `switch_page` to go back to previous tabs.\n" +
  "- `navigate` already returns an element snapshot — no need to call `find` separately right after.\n" +
  "- Prefer `get_text` over `get_html` — it returns rendered text, not raw markup.\n" +
  "- Use `screenshot` when you need visual confirmation (layout, CAPTCHAs, UI verification).\n" +
  "- This operates on the USER's browser — all logins, cookies, and sessions are live.\n" +
  "- The user can watch what you're doing in their browser.\n" +
  "- First-time setup: load the extension from extensions/chrome/ in chrome://extensions\n" +
  "</instructions>";

const PROMPT_HINT =
  "Browser control (`browser`):\n" +
  "- Connects to the user's real Chrome — all logins, cookies, and sessions are live.\n" +
  "- **Element finding (preferred):** `find` → pick @eN refs → `click_ref` / `type_ref`.\n" +
  "- CSS selectors (`click` / `type`) are available but brittle on dynamic pages.\n" +
  "- `navigate` returns text + element snapshot together — no separate `find` needed.\n" +
  "- Use `list_pages` first to see what's open.\n" +
  "- PREFER `get_text` for reading page content — it returns rendered text, not raw HTML.\n" +
  "- Use `screenshot` for visual confirmation (layout, CAPTCHAs, UI verification).\n" +
  "- The user watches what you do — be transparent in your plan summary.";

const LEAN_DESCRIPTION =
  "Operate the user's Chrome browser via extension.\n" +
  "Actions: navigate, find, click_ref, type_ref, click, type, scroll, get_text, get_html, screenshot, wait, list_pages, switch_page.\n" +
  "Requires the huko Chrome extension loaded from extensions/chrome/";

// ─── Parameter schema ───────────────────────────────────────────────────────

const PARAMETERS = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: [
        "navigate",
        "click",
        "type",
        "scroll",
        "get_text",
        "get_html",
        "screenshot",
        "wait",
        "list_pages",
        "switch_page",
        "find",
        "click_ref",
        "type_ref",
      ],
      description: "The browser operation to perform.",
    },
    url: {
      type: "string" as const,
      description: "Required for `navigate`. Full http(s) URL.",
    },
    selector: {
      type: "string" as const,
      description: "CSS selector. Used by: click, type, screenshot (optional), wait (optional).",
    },
    ref: {
      type: "string" as const,
      description: "Element reference from `find` snapshot (e.g. '5' for @e5). Used by: click_ref, type_ref.",
    },
    text: {
      type: "string" as const,
      description: "Text to type. Required for `type` and `type_ref`.",
    },
    direction: {
      type: "string" as const,
      enum: ["up", "down", "top", "bottom"],
      description: "Scroll direction. Default for `scroll`: `down`.",
    },
    ms: {
      type: "number" as const,
      description: "Milliseconds. Used by `wait` for a plain timeout.",
    },
    index: {
      type: "number" as const,
      description: "Page index (from list_pages). Required for `switch_page`.",
    },
  },
  required: ["action"],
};

// ─── Registration ───────────────────────────────────────────────────────────

registerServerTool(
  {
    name: "browser",
    feature: "browser-control",
    description: DESCRIPTION,
    leanDescription: LEAN_DESCRIPTION,
    parameters: PARAMETERS,
    dangerLevel: "moderate",
    promptHint: PROMPT_HINT,
  },
  async (args): Promise<ToolHandlerResult> => {
    const action = String(args["action"] ?? "navigate");

    try {
      switch (action) {
        case "navigate": {
          const url = String(args["url"] ?? "").trim();
          if (!url) {
            return errorResult("`url` is required for action=navigate.");
          }
          if (!/^https?:\/\//i.test(url)) {
            return errorResult(`Only http(s) URLs are accepted (got: ${url}).`);
          }
          const content = await browserNavigate(url);
          return {
            content,
            summary: `browser navigate → ${url}`,
            metadata: { action: "navigate", url },
          };
        }

        case "click": {
          const selector = String(args["selector"] ?? "").trim();
          if (!selector) {
            return errorResult("`selector` is required for action=click.");
          }
          const content = await browserClick(selector);
          return {
            content,
            summary: `browser click → ${selector}`,
            metadata: { action: "click", selector },
          };
        }

        case "type": {
          const selector = String(args["selector"] ?? "").trim();
          const text = String(args["text"] ?? "");
          if (!selector) {
            return errorResult("`selector` is required for action=type.");
          }
          if (!text) {
            return errorResult("`text` is required for action=type.");
          }
          const content = await browserType(selector, text);
          return {
            content,
            summary: `browser type → ${selector}`,
            metadata: { action: "type", selector },
          };
        }

        case "scroll": {
          const direction = String(args["direction"] ?? "down").trim();
          const content = await browserScroll(direction);
          return {
            content,
            summary: `browser scroll → ${direction}`,
            metadata: { action: "scroll", direction },
          };
        }

        case "get_text": {
          const content = await browserGetText();
          return {
            content,
            summary: "browser get_text",
            metadata: { action: "get_text" },
          };
        }

        case "get_html": {
          const content = await browserGetHtml();
          return {
            content,
            summary: "browser get_html",
            metadata: { action: "get_html" },
          };
        }

        case "screenshot": {
          const selector = typeof args["selector"] === "string"
            ? String(args["selector"]).trim()
            : undefined;
          const { buffer, filename } = await browserScreenshot(selector || undefined);
          const filePath = path.join(tmpdir(), filename);
          writeFileSync(filePath, buffer);
          return {
            content: `Screenshot saved: ${filename} (${buffer.length} bytes)`,
            summary: "browser screenshot",
            metadata: { action: "screenshot", bytes: buffer.length },
            attachments: [
              {
                filename,
                mimeType: "image/png",
                size: buffer.length,
                path: filePath,
              },
            ],
          };
        }

        case "wait": {
          const selector = typeof args["selector"] === "string"
            ? String(args["selector"]).trim()
            : undefined;
          const ms = typeof args["ms"] === "number" ? args["ms"] : undefined;
          if (!selector && (ms === undefined || ms === null)) {
            return errorResult("`wait` requires either a `selector` or `ms` parameter.");
          }
          const content = await browserWait(selector || undefined, ms);
          return {
            content,
            summary: "browser wait",
            metadata: { action: "wait", selector: selector ?? null, ms: ms ?? null },
          };
        }

        case "list_pages": {
          const content = await browserListPages();
          return {
            content,
            summary: "browser list_pages",
            metadata: { action: "list_pages" },
          };
        }

        case "switch_page": {
          const index = args["index"];
          if (typeof index !== "number" || !Number.isFinite(index)) {
            return errorResult("`index` (number) is required for action=switch_page.");
          }
          const content = await browserSwitchPage(Math.floor(index));
          return {
            content,
            summary: `browser switch_page → ${index}`,
            metadata: { action: "switch_page", index: Math.floor(index) },
          };
        }

        // ── v2: element-ref actions ──────────────────────────────

        case "find": {
          const content = await browserFind();
          return {
            content,
            summary: "browser find",
            metadata: { action: "find" },
          };
        }

        case "click_ref": {
          const ref = String(args["ref"] ?? "").trim();
          if (!ref) {
            return errorResult("`ref` is required for action=click_ref (e.g. ref='5' for @e5).");
          }
          const content = await browserClickRef(ref);
          return {
            content,
            summary: `browser click_ref → @${ref}`,
            metadata: { action: "click_ref", ref },
          };
        }

        case "type_ref": {
          const ref = String(args["ref"] ?? "").trim();
          const text = String(args["text"] ?? "");
          if (!ref) {
            return errorResult("`ref` is required for action=type_ref (e.g. ref='3' for @e3).");
          }
          if (!text) {
            return errorResult("`text` is required for action=type_ref.");
          }
          const content = await browserTypeRef(ref, text);
          return {
            content,
            summary: `browser type_ref → @${ref}`,
            metadata: { action: "type_ref", ref },
          };
        }

        default: {
          return errorResult(
            `Unknown action "${action}". Valid: navigate, click, type, scroll, get_text, get_html, screenshot, wait, list_pages, switch_page, find, click_ref, type_ref.`,
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`browser ${action} failed: ${msg}`);
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function errorResult(message: string): ToolHandlerResult {
  return {
    content: `Error: ${message}`,
    error: message,
    summary: `browser refused`,
  };
}
