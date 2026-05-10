/**
 * Tool: web_search
 *
 * Run a search engine query and return ranked results. v1 ships ONE
 * provider: DuckDuckGo's HTML endpoint (no API key, no sign-up).
 */

import { registerServerTool, type ToolHandlerResult } from "../registry.js";
import { getConfig } from "../../../config/index.js";

const DESCRIPTION =
  "Search the web and return a ranked list of result links + snippets.\n\n" +
  "<instructions>\n" +
  "- Use this BEFORE `web_fetch` whenever you don't already have a URL — `web_fetch` only retrieves a URL you already have, it does NOT search\n" +
  "- The query string should be plain natural language; no quotes or special operators required\n" +
  "- Returned results are ranked: pick the top 1-3 you actually intend to read, then `web_fetch` each one to get the full body\n" +
  "- For non-English topics, run at least one English query in addition; coverage outside one language is often the difference between a thin summary and a real one\n" +
  "- Treat snippets as previews, NOT facts — quote / cite from the actual page contents fetched via `web_fetch`\n" +
  "</instructions>";

const PARAMETERS = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "Plain-language search query.",
    },
    count: {
      type: "number" as const,
      description:
        "Max number of results to return. Defaults to the per-call max (10). Capped at the configured maxResults.",
    },
  },
  required: ["query"],
};

const WEB_SEARCH_PROMPT_HINT = [
  "Web research (`web_search` + `web_fetch`):",
  "- Use `web_search` BEFORE `web_fetch` whenever you don't already have a URL — `web_fetch` only retrieves a known URL, it does NOT search.",
  "- `web_search` returns ranked snippets; pick the top 1-3 and `web_fetch` each one for the full body.",
  "- Treat snippets as previews, NOT facts. Cite from the actual fetched page.",
  "- For non-English topics, run at least one English query in addition to the user's native-language one.",
].join("\n");

registerServerTool(
  {
    name: "web_search",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    dangerLevel: "safe",
    promptHint: WEB_SEARCH_PROMPT_HINT,
  },
  async (args): Promise<ToolHandlerResult> => {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      return errorResult("query is required and must be non-empty");
    }

    const cfg = getConfig().tools.webSearch;
    const fetchCap = getConfig().tools.webFetch.maxBytes;

    const requested =
      typeof args["count"] === "number" && Number.isFinite(args["count"])
        ? Math.floor(args["count"] as number)
        : cfg.maxResults;
    const count = Math.max(1, Math.min(requested, cfg.maxResults));

    try {
      const results = await runSearch(cfg.provider, query, {
        timeoutMs: cfg.timeoutMs,
        maxBodyBytes: fetchCap,
        max: count,
      });

      if (results.length === 0) {
        return {
          content: `No results for "${query}".`,
          summary: `web_search -> 0 results`,
          metadata: { query, provider: cfg.provider, results: [] },
        };
      }

      const text = formatResults(query, results);
      return {
        content: text,
        summary: `web_search -> ${results.length} results`,
        metadata: { query, provider: cfg.provider, results },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`web_search failed: ${msg}`);
    }
  },
);

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type SearchOptions = {
  timeoutMs: number;
  maxBodyBytes: number;
  max: number;
};

async function runSearch(
  provider: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  switch (provider) {
    case "duckduckgo":
      return await searchDuckDuckGo(query, opts);
    default:
      throw new Error(`unknown search provider: ${provider}`);
  }
}

const DDG_URL = "https://html.duckduckgo.com/html/";

async function searchDuckDuckGo(
  query: string,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(DDG_URL, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`DuckDuckGo HTTP ${res.status} ${res.statusText}`);
  }

  const html = await readCapped(res, opts.maxBodyBytes);
  return parseDuckDuckGoHtml(html, opts.max);
}

/**
 * Parse DuckDuckGo's HTML result page. Exported for tests so we can
 * pin the parser against fixture HTML.
 */
export function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRe = /<a\s+[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a\s+[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const href = m[1] ?? "";
    const titleHtml = m[2] ?? "";
    const snippetHtml = m[3] ?? "";

    const url = unwrapDdgRedirect(href);
    if (!url) continue;
    const title = decodeEntities(stripTags(titleHtml)).trim();
    const snippet = decodeEntities(stripTags(snippetHtml)).trim();
    if (!title || !url) continue;

    results.push({ title, url, snippet });
    if (results.length >= max) break;
  }

  return results;
}

function unwrapDdgRedirect(href: string): string | null {
  if (!href) return null;
  const normalized = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(normalized);
    if (
      u.hostname.endsWith("duckduckgo.com") &&
      u.pathname === "/l/" &&
      u.searchParams.has("uddg")
    ) {
      const real = u.searchParams.get("uddg");
      if (real) return real;
    }
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    });
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      const overrun = total - maxBytes;
      chunks.push(value.subarray(0, value.byteLength - overrun));
      break;
    }
    chunks.push(value);
  }
  reader.cancel().catch(() => {
    /* noop */
  });
  const buf = new Uint8Array(total > maxBytes ? maxBytes : total);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

function formatResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [`Search: ${query}`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function errorResult(message: string): ToolHandlerResult {
  return {
    content: `Error: ${message}`,
    error: message,
    summary: "web_search refused",
  };
}
