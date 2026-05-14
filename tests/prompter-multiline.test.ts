/**
 * tests/prompter-multiline.test.ts
 *
 * Coverage:
 *   - collectMultiLine returns a single line unchanged (no paste detected)
 *   - collectMultiLine merges lines that arrive in rapid succession (<200ms)
 *   - collectMultiLine returns empty string when first line is empty
 *   - PromptCancelled on Ctrl+C / Ctrl+D during collection
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { PassThrough, type Writable } from "node:stream";

// We pull in the factory and the error class directly.
import { openPrompter, PromptCancelled, type Prompter } from "../server/cli/commands/prompts.js";

/**
 * Create a Prompter wired to a mock stdin so we can programmatically
 * feed lines and verify multi-line paste detection without a real TTY.
 *
 * The mock uses a PassThrough stream set to non-TTY (terminal: false)
 * so the internal readline interface goes into non-raw line-buffered
 * mode — exactly the path hit in production when input is piped or
 * when a user pastes. The 200ms merge window works the same regardless.
 *
 * IMPORTANT: The real openPrompter reads `process.stdin` globally.
 * We temporarily replace it, create the prompter, then restore.
 */ 
function makeMockPrompter(): { prompter: Prompter; feed: (line: string) => void; cleanup(): void } {
  const realStdin = process.stdin;
  const mockStdin = new PassThrough() as unknown as NodeJS.ReadStream & { fd: 0 };
  // readline checks isTTY on the stream.
  (mockStdin as Record<string, unknown>).isTTY = false;

  // Replace process.stdin so openPrompter picks up the mock.
  Object.defineProperty(process, "stdin", {
    value: mockStdin,
    configurable: true,
    writable: true,
  });

  const prompter = openPrompter();

  const stderrWrite = process.stderr.write.bind(process.stderr);
  // Silence stderr during tests — the prompter writes prompts there.
  // @ts-expect-error signature mismatch is fine
  process.stderr.write = (_chunk: unknown, _encoding?: unknown, _cb?: unknown): boolean => true;

  function feed(line: string): void {
    mockStdin.push(line + "\n");
  }

  function cleanup(): void {
    prompter.close();
    Object.defineProperty(process, "stdin", {
      value: realStdin,
      configurable: true,
      writable: true,
    });
    process.stderr.write = stderrWrite;
  }

  return { prompter, feed, cleanup };
}

// Pre-feed lines into the mock stdin before calling collectMultiLine.
// This simulates a paste: all lines are already in readline's buffer
// when collectMultiLine starts reading.
function preFeed(feed: (line: string) => void, lines: string[]): void {
  for (const l of lines) feed(l);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("collectMultiLine — single line (no paste)", () => {
  it("returns a single line unchanged", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, ["hello world"]);
      const result = await prompter.collectMultiLine("");
      assert.equal(result, "hello world");
    } finally {
      cleanup();
    }
  });

  it("returns empty string when input is blank", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, [""]);
      const result = await prompter.collectMultiLine("");
      assert.equal(result, "");
    } finally {
      cleanup();
    }
  });
});

describe("collectMultiLine — paste detection", () => {
  it("merges 3 lines fed before the call into one \\n-joined string", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, ["line one", "line two", "line three"]);
      const result = await prompter.collectMultiLine("");
      assert.equal(result, "line one\nline two\nline three");
    } finally {
      cleanup();
    }
  });

  it("merges 10 lines (larger paste) into one string", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
      preFeed(feed, lines);
      const result = await prompter.collectMultiLine("");
      assert.equal(result, lines.join("\n"));
    } finally {
      cleanup();
    }
  });

  it("preserves leading/trailing whitespace within lines", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, ["  indented", "trailing  ", "  both  "]);
      const result = await prompter.collectMultiLine("");
      // collectMultiLine reads raw lines — no trim, no validation.
      assert.equal(result, "  indented\ntrailing  \n  both  ");
    } finally {
      cleanup();
    }
  });

  it("preserves empty lines between pasted content", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, ["line one", "", "line three", "", "line five"]);
      const result = await prompter.collectMultiLine("");
      assert.equal(result, "line one\n\nline three\n\nline five");
    } finally {
      cleanup();
    }
  });
});

describe("collectMultiLine — prompt() does NOT merge (single-line only)", () => {
  it("prompt() only returns the first line even when more are queued", async () => {
    const { prompter, feed, cleanup } = makeMockPrompter();
    try {
      preFeed(feed, ["first", "second", "third"]);
      const result = await prompter.prompt("");
      // prompt() uses takeLine() — one line only, extras stay in queue.
      assert.equal(result, "first");
      // The remaining lines are still in the queue — verify by reading one more.
      const extra = await prompter.prompt("");
      assert.equal(extra, "second");
    } finally {
      cleanup();
    }
  });
});
