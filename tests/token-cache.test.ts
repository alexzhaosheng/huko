/**
 * tests/token-cache.test.ts
 *
 * Cache-token plumbing — end-to-end across the pipeline:
 *
 *   1. OpenAI adapter normalises both shapes
 *      (prompt_tokens_details.cached_tokens vs flat cache_read_input_tokens)
 *   2. TaskContext.addTokens accumulates cache fields across calls
 *   3. formatTokenBreakdown renders the right rows with and without cache
 *
 * No real network — the adapter test stubs globalThis.fetch.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

import { openaiAdapter } from "../server/core/llm/adapters/openai.js";
import { TaskContext } from "../server/engine/TaskContext.js";
import { formatTokenBreakdown } from "../server/cli/commands/run.js";
import type { TaskRunSummary } from "../server/task/task-loop.js";

// ─── 1. Adapter normalisation ───────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch;

function stubFetchOnce(jsonBody: unknown): { restore: () => void } {
  const original: FetchFn = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(jsonBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as FetchFn;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("openai adapter — cache-token normalisation", () => {
  it("extracts OpenAI-shape prompt_tokens_details.cached_tokens", async () => {
    const stub = stubFetchOnce({
      choices: [{ message: { content: "hi" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    try {
      const res = await openaiAdapter.call({
        protocol: "openai",
        baseUrl: "http://example",
        apiKey: "x",
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolCallMode: "native",
        thinkLevel: "off",
      });
      assert.equal(res.usage.cachedTokens, 800);
      assert.equal(res.usage.cacheCreationTokens, undefined);
      assert.equal(res.usage.promptTokens, 1000);
    } finally {
      stub.restore();
    }
  });

  it("extracts Anthropic-shim flat cache_read_input_tokens / cache_creation_input_tokens", async () => {
    const stub = stubFetchOnce({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 100,
        total_tokens: 2100,
        cache_read_input_tokens: 1500,
        cache_creation_input_tokens: 250,
      },
    });
    try {
      const res = await openaiAdapter.call({
        protocol: "openai",
        baseUrl: "http://example",
        apiKey: "x",
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolCallMode: "native",
        thinkLevel: "off",
      });
      assert.equal(res.usage.cachedTokens, 1500);
      assert.equal(res.usage.cacheCreationTokens, 250);
    } finally {
      stub.restore();
    }
  });

  it("omits cache fields when provider doesn't report them", async () => {
    const stub = stubFetchOnce({
      choices: [{ message: { content: "no-cache" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    try {
      const res = await openaiAdapter.call({
        protocol: "openai",
        baseUrl: "http://example",
        apiKey: "x",
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolCallMode: "native",
        thinkLevel: "off",
      });
      assert.equal(res.usage.cachedTokens, undefined);
      assert.equal(res.usage.cacheCreationTokens, undefined);
    } finally {
      stub.restore();
    }
  });
});

// ─── 2. TaskContext.addTokens accumulation ──────────────────────────────────

function makeCtx(): TaskContext {
  return new TaskContext({
    taskId: 1,
    sessionType: "chat",
    chatSessionId: 1,
    protocol: "openai",
    modelId: "test",
    baseUrl: "http://x",
    apiKey: "x",
    toolCallMode: "native",
    thinkLevel: "off",
    contextWindow: 8192,
    tools: [],
    systemPrompt: "",
    // SessionContext is not actually exercised by addTokens / summary.
    sessionContext: {} as unknown as ConstructorParameters<typeof TaskContext>[0]["sessionContext"],
  });
}

describe("TaskContext.addTokens — cache field accumulation", () => {
  it("accumulates cachedTokens and cacheCreationTokens across calls", () => {
    const ctx = makeCtx();
    ctx.addTokens({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
      cachedTokens: 800,
      cacheCreationTokens: 100,
    });
    ctx.addTokens({
      promptTokens: 2000,
      completionTokens: 80,
      totalTokens: 2080,
      cachedTokens: 1500,
      cacheCreationTokens: 50,
    });
    const s = ctx.summary();
    assert.equal(s.promptTokens, 3000);
    assert.equal(s.completionTokens, 130);
    assert.equal(s.totalTokens, 3130);
    assert.equal(s.cachedTokens, 2300);
    assert.equal(s.cacheCreationTokens, 150);
  });

  it("leaves cache fields at 0 when calls don't report them", () => {
    const ctx = makeCtx();
    ctx.addTokens({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    ctx.addTokens({ promptTokens: 200, completionTokens: 30, totalTokens: 230 });
    const s = ctx.summary();
    assert.equal(s.cachedTokens, 0);
    assert.equal(s.cacheCreationTokens, 0);
    assert.equal(s.totalTokens, 350);
  });

  it("ignores cache fields when they're zero on a per-call basis", () => {
    const ctx = makeCtx();
    ctx.addTokens({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    });
    assert.equal(ctx.summary().cachedTokens, 0);
    assert.equal(ctx.summary().cacheCreationTokens, 0);
  });
});

// ─── 3. formatTokenBreakdown output ─────────────────────────────────────────

function summary(overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    status: "done",
    finalResult: "",
    hasExplicitResult: false,
    toolCallCount: 0,
    iterationCount: 1,
    promptTokens: 1234,
    completionTokens: 567,
    totalTokens: 1801,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("formatTokenBreakdown", () => {
  it("renders only input/output when no cache fields (no `total` row)", () => {
    const out = formatTokenBreakdown(summary());
    const lines = out.split("\n");
    assert.equal(lines[0], "Token usage:");
    // 2 data rows: input, output. NO `total` — different per-token
    // costs make the sum misleading.
    assert.equal(lines.length, 3);
    assert.match(lines[1]!, /input\s+1,234/);
    assert.match(lines[2]!, /output\s+567/);
    assert.ok(!out.includes("total"));
    assert.ok(!out.includes("cache read"));
    assert.ok(!out.includes("cache write"));
  });

  it("inserts cache read row when cachedTokens > 0", () => {
    const out = formatTokenBreakdown(
      summary({ promptTokens: 1000, cachedTokens: 800, totalTokens: 1567 }),
    );
    assert.ok(out.includes("cache read"));
    assert.ok(!out.includes("cache write"));
    assert.ok(!out.includes("total"));
    assert.match(out, /cache read\s+800/);
    // Order: input, cache (read), output — first token of each row.
    const rows = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]);
    assert.deepEqual(rows, ["input", "cache", "output"]);
  });

  it("inserts both cache rows when both fields populated", () => {
    const out = formatTokenBreakdown(
      summary({
        promptTokens: 2000,
        cachedTokens: 1500,
        cacheCreationTokens: 250,
        totalTokens: 2567,
      }),
    );
    assert.ok(out.includes("cache read"));
    assert.ok(out.includes("cache write"));
    assert.ok(!out.includes("total"));
    assert.match(out, /cache write\s+250/);
  });

  it("right-aligns numbers with thousands separators", () => {
    const out = formatTokenBreakdown(
      summary({
        promptTokens: 1_234_567,
        completionTokens: 8,
      }),
    );
    // Both numbers padded to the same width (the longest one).
    assert.ok(out.includes("1,234,567"));
    // The 8 should be right-aligned (padded with spaces).
    assert.match(out, / {7}8/);
  });
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

before(() => {
  // No-op — placeholder if we need global setup later.
});
after(() => {
  // No-op — placeholder.
});
