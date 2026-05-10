/**
 * tests/web-search.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: register tools.
import "../server/task/tools/index.js";
import {
  getTool,
  getToolPromptHints,
  type ToolHandlerResult,
} from "../server/task/tools/registry.js";
import type { TaskContext } from "../server/engine/TaskContext.js";
import { parseDuckDuckGoHtml } from "../server/task/tools/server/web-search.js";

const stubCtx = {} as unknown as TaskContext;

async function call(args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const tool = getTool("web_search");
  if (!tool || tool.kind !== "server") throw new Error("web_search not registered");
  const r = await Promise.resolve(tool.handler(args, stubCtx, { toolCallId: "t" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) return r as ToolHandlerResult;
  return { content: r.result, error: r.error ?? null };
}

// ─── parseDuckDuckGoHtml ────────────────────────────────────────────────────

describe("parseDuckDuckGoHtml", () => {
  const FIXTURE = `
    <html><body>
      <div class="result results_links">
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Title One</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First snippet text with &amp; entity.</a>
      </div>
      <div class="result results_links">
        <h2 class="result__title">
          <a class="result__a" href="https://direct.example.org/page">Direct URL Result &amp; co.</a>
        </h2>
        <a class="result__snippet">Second snippet, also with &#39;quoted&#39; bits.</a>
      </div>
      <div class="result results_links">
        <h2 class="result__title">
          <a class="result__a" href="javascript:void(0)">Bad URL</a>
        </h2>
        <a class="result__snippet">should be dropped.</a>
      </div>
    </body></html>
  `;

  it("extracts results in document order", () => {
    const got = parseDuckDuckGoHtml(FIXTURE, 10);
    assert.equal(got.length, 2, "bad URL row should be dropped");
    assert.equal(got[0]!.title, "Title One");
    assert.equal(got[0]!.url, "https://example.com/a");
    assert.match(got[0]!.snippet, /First snippet text with & entity\./);
    assert.equal(got[1]!.title, "Direct URL Result & co.");
    assert.equal(got[1]!.url, "https://direct.example.org/page");
    assert.match(got[1]!.snippet, /'quoted' bits/);
  });

  it("respects max parameter", () => {
    const got = parseDuckDuckGoHtml(FIXTURE, 1);
    assert.equal(got.length, 1);
  });

  it("returns empty array on unrecognised HTML", () => {
    const got = parseDuckDuckGoHtml("<html><body>no results</body></html>", 10);
    assert.deepEqual(got, []);
  });
});

// ─── tool-level argument handling ───────────────────────────────────────────

describe("web_search — argument handling", () => {
  it("rejects empty query", async () => {
    const r = await call({ query: "" });
    assert.ok(r.error);
    assert.match(r.content, /query is required/i);
  });

  it("rejects whitespace-only query", async () => {
    const r = await call({ query: "   " });
    assert.ok(r.error);
  });
});

// ─── network-mocked end-to-end ──────────────────────────────────────────────

describe("web_search — mocked DuckDuckGo round-trip", () => {
  it("parses results from a mocked HTTP response", async () => {
    const fixture = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fapi.example.com%2Fdocs">Library docs</a>
        <a class="result__snippet">Authoritative docs page.</a>
      </div>
    `;

    const originalFetch = globalThis.fetch;
    let capturedUrl: string | null = null;
    let capturedBody: string | null = null;
    globalThis.fetch = (async (url: unknown, init: { body?: string } = {}) => {
      capturedUrl = String(url);
      capturedBody = init.body ?? null;
      return new Response(fixture, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    try {
      const r = await call({ query: "library docs", count: 5 });
      assert.equal(r.error ?? null, null, r.content);
      assert.match(r.content, /1\. Library docs/);
      assert.match(r.content, /https:\/\/api\.example\.com\/docs/);
      assert.match(r.content, /Authoritative docs page\./);
      assert.ok(capturedUrl?.includes("duckduckgo.com"), `unexpected URL: ${capturedUrl}`);
      assert.match(String(capturedBody), /q=library\+docs/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces HTTP errors as tool errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
    try {
      const r = await call({ query: "x" });
      assert.ok(r.error);
      assert.match(r.content, /HTTP 403/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 'no results' message when parser finds nothing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><body>captcha</body></html>", { status: 200 })) as typeof fetch;
    try {
      const r = await call({ query: "obscure query" });
      assert.equal(r.error ?? null, null);
      assert.match(r.content, /No results for/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── promptHint contract ────────────────────────────────────────────────────

describe("web_search — promptHint contract", () => {
  it("registers a non-empty promptHint that pairs search with fetch", () => {
    const tool = getTool("web_search");
    assert.ok(tool && tool.kind === "server", "web_search should be a registered server tool");
    const hint = tool!.definition.promptHint ?? "";
    assert.ok(hint.length > 0, "web_search must contribute a promptHint");
    // Inter-tool coordination is the whole point of having a hint here:
    // the LLM needs to know `web_search` precedes `web_fetch`.
    assert.match(hint, /web_search/);
    assert.match(hint, /web_fetch/);
  });

  it("shows up in getToolPromptHints output (hint is wired into the collector)", () => {
    const hints = getToolPromptHints();
    const found = hints.find((h) => h.includes("Web research"));
    assert.ok(found, "web_search promptHint should appear in getToolPromptHints()");
    assert.match(found!, /web_search[\s\S]*web_fetch/);
  });

  it("disappears from hints when the tool is denied", () => {
    const hints = getToolPromptHints({ deniedTools: ["web_search"] });
    const found = hints.find((h) => h.includes("Web research"));
    assert.equal(found, undefined, "web_search hint should be filtered out when denied");
  });
});
