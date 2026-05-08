/**
 * Tool: web_fetch
 *
 * A minimal HTTP GET tool. Lets the model pull a single URL and read
 * either the raw HTML or a stripped text view (tags removed, scripts
 * and styles stripped, whitespace collapsed).
 *
 * This tool is the smallest possible "real" server tool — its job is
 * to exercise the v2 registration / coercion / result pipeline end to
 * end. More elaborate browsing (search results, multi-page sweeps,
 * JS rendering) belongs to a heavier tool that ships later.
 *
 * Limits:
 *   - Only `GET` is supported.
 *   - Body capped at MAX_BYTES (1 MiB).
 *   - 20 second hard timeout.
 *   - Redirects: followed (default `redirect: "follow"`).
 */

import { registerServerTool, type ToolHandlerResult } from "../registry.js";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB
const TIMEOUT_MS = 20_000;

const WEB_FETCH_DESCRIPTION =
  "Fetch the contents of a single URL via HTTP GET.\n\n" +
  "<modes>\n" +
  "- `text` (default): Strip HTML tags, scripts and styles, collapse whitespace. Best for reading article bodies.\n" +
  "- `html`: Return the raw HTML body unchanged. Useful when you need to extract structured pieces yourself.\n" +
  "</modes>\n\n" +
  "<instructions>\n" +
  "- Only `http(s)` URLs are accepted\n" +
  "- The response body is capped at 1 MiB; longer pages are truncated\n" +
  "- Hard timeout of 20 seconds; on timeout the tool returns an error result\n" +
  "- Use `text` mode unless you specifically need the raw HTML\n" +
  "- Do NOT use this tool to make POST / PUT / DELETE / PATCH requests\n" +
  "</instructions>";

registerServerTool(
  {
    name: "web_fetch",
    description: WEB_FETCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch",
        },
        mode: {
          type: "string",
          enum: ["text", "html"],
          description: "Response shaping mode. Defaults to `text`.",
        },
      },
      required: ["url"],
    },
    dangerLevel: "safe",
    display: {
      compactTemplate: '<web_fetch mode="{mode}">{url}</web_fetch>',
      extractParams: (args) => ({
        url: String(args["url"] ?? "").slice(0, 120),
        mode: String(args["mode"] ?? "text"),
      }),
    },
  },
  async (args): Promise<ToolHandlerResult> => {
    const url = String(args["url"] ?? "").trim();
    const mode = args["mode"] === "html" ? "html" : "text";

    if (!url) {
      return {
        content: "Error: `url` is required.",
        error: "missing url",
      };
    }
    if (!/^https?:\/\//i.test(url)) {
      return {
        content: `Error: only http(s) URLs are accepted (got: ${url}).`,
        error: "invalid scheme",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": "huko-web-fetch/1.0",
          "accept": mode === "html"
            ? "text/html,application/xhtml+xml"
            : "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: `Error: request to ${url} timed out after ${TIMEOUT_MS}ms.`,
          error: "timeout",
        };
      }
      return {
        content: `Error: fetch failed — ${errorMessage(err)}.`,
        error: "fetch failed",
      };
    }
    clearTimeout(timer);

    if (!response.ok) {
      // Still return body if available, but mark as error so the LLM
      // sees a clear signal.
      const status = `${response.status} ${response.statusText}`;
      let snippet = "";
      try {
        const t = await response.text();
        snippet = t.slice(0, 500);
      } catch {
        /* ignore */
      }
      return {
        content: `Error: HTTP ${status}${snippet ? `\n\n${snippet}` : ""}`,
        error: `http ${response.status}`,
        metadata: { status: response.status, finalUrl: response.url },
      };
    }

    // Read body (with byte cap)
    let raw: string;
    try {
      raw = await readCapped(response, MAX_BYTES);
    } catch (err: unknown) {
      return {
        content: `Error: failed to read body — ${errorMessage(err)}.`,
        error: "read failed",
      };
    }

    const truncated = raw.length >= MAX_BYTES;

    const body = mode === "html" ? raw : extractText(raw);

    const headerLines = [
      `URL: ${response.url}`,
      `Status: ${response.status}`,
      `Mode: ${mode}`,
      `Bytes: ${raw.length}${truncated ? " (truncated)" : ""}`,
    ];

    return {
      content: `${headerLines.join("\n")}\n\n${body}`,
      summary: `web_fetch ${mode} ${response.url}`,
      metadata: {
        finalUrl: response.url,
        status: response.status,
        mode,
        bytes: raw.length,
        truncated,
      },
    };
  },
);

// ─── helpers ─────────────────────────────────────────────────────────────────

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  // Fast path — whatwg fetch in Node 18+ handles streams; we cap by
  // reading text() and slicing, which is good enough for an LLM tool.
  // (For very large bodies, a true streaming reader would be better;
  //  defer that until we see a real need.)
  const text = await response.text();
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes);
}

/**
 * Cheap HTML → text extraction. Strips <script> and <style> bodies,
 * removes all tags, decodes a handful of common entities, collapses
 * whitespace. Not a substitute for a real parser, but plenty for
 * "let the model read this article" use cases.
 */
function extractText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[\t\f\v\r ]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCharCode(code) : m;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCharCode(code) : m;
    }
    return ENTITY_MAP[body.toLowerCase()] ?? m;
  });
}

function safeFromCharCode(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
