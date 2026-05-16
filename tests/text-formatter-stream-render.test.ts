/**
 * tests/text-formatter-stream-render.test.ts
 *
 * Regression coverage for the streaming-markdown gap: when stdout is a
 * TTY and `renderMarkdown` is on, the text formatter must buffer the
 * `assistant_content_delta` stream and run `renderMd` over the whole
 * blob at `assistant_complete`. Writing each delta raw makes `marked`
 * see half-finished `**bold**` markers and produces wrong output.
 *
 * Asserts behaviour at the formatter level — `renderMd` itself is
 * already covered by markdown-render.test.ts.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { makeTextFormatter } from "../server/cli/formatters/text.js";
import type { HukoEvent } from "../shared/events.js";

// ─── TTY / stdout mocking ───────────────────────────────────────────────────

let originalWrite: typeof process.stdout.write;
let originalTTY: PropertyDescriptor | undefined;
let originalForceColor: string | undefined;
let stdoutChunks: string[];

function captureStdout(isTTY: boolean): void {
  stdoutChunks = [];
  originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  originalForceColor = process.env.FORCE_COLOR;
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  if (isTTY) process.env.FORCE_COLOR = "1";

  originalWrite = process.stdout.write.bind(process.stdout);
  // Cast: write has overloaded signatures; we only need the (string)=>boolean
  // shape for these tests.
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
}

function restoreStdout(): void {
  (process.stdout.write as unknown) = originalWrite;
  if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
  else Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  if (originalForceColor !== undefined) process.env.FORCE_COLOR = originalForceColor;
  else delete process.env.FORCE_COLOR;
}

beforeEach(() => {
  stdoutChunks = [];
});

afterEach(() => {
  restoreStdout();
});

// ─── Event helpers ──────────────────────────────────────────────────────────

const BASE = { entryId: 1, taskId: 1, sessionId: 1, sessionType: "chat" as const, ts: 0 };

function deltaEvent(text: string): HukoEvent {
  return {
    type: "assistant_content_delta",
    entryId: BASE.entryId,
    taskId: BASE.taskId,
    sessionId: BASE.sessionId,
    sessionType: BASE.sessionType,
    delta: text,
  };
}

function completeEvent(): HukoEvent {
  return {
    type: "assistant_complete",
    ...BASE,
    content: "",
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("text formatter — streaming markdown rendering", () => {
  it("buffers deltas and renders the whole document at assistant_complete (TTY + renderMarkdown)", () => {
    captureStdout(true);
    const fmt = makeTextFormatter({ verbose: false, renderMarkdown: true });

    // Split a markdown blob across deltas so `marked` would mis-parse
    // each one individually (open `**`, dangling `*`).
    fmt.emitter.emit(deltaEvent("Here is **bo"));
    fmt.emitter.emit(deltaEvent("ld** text and *it"));
    fmt.emitter.emit(deltaEvent("alic*."));

    // During streaming, NOTHING should hit stdout — we're buffering.
    assert.equal(stdoutChunks.length, 0, `expected buffered, got: ${JSON.stringify(stdoutChunks)}`);

    fmt.emitter.emit(completeEvent());

    // After completion, exactly one stdout write with the rendered text
    // + trailing newline. ANSI escapes are environment-sensitive; the
    // invariant is "no raw markdown markers left".
    assert.equal(stdoutChunks.length, 1);
    const out = stdoutChunks[0]!;
    assert.ok(out.includes("bold"), `expected "bold" in: ${JSON.stringify(out)}`);
    assert.ok(out.includes("italic"), `expected "italic" in: ${JSON.stringify(out)}`);
    assert.ok(out.endsWith("\n"), `expected trailing newline in: ${JSON.stringify(out)}`);
    assert.ok(!out.includes("**"), `raw \`**\` should have been rendered, got: ${JSON.stringify(out)}`);
  });

  it("streams deltas raw when stdout is NOT a TTY (pipe consumers get tokens as they arrive)", () => {
    captureStdout(false);
    const fmt = makeTextFormatter({ verbose: false, renderMarkdown: true });

    fmt.emitter.emit(deltaEvent("hello "));
    fmt.emitter.emit(deltaEvent("world"));

    // Each delta wrote raw.
    assert.deepEqual(stdoutChunks, ["hello ", "world"]);

    fmt.emitter.emit(completeEvent());
    // assistant_complete adds the trailing newline (no rendering, since
    // streamBuffer stayed empty).
    assert.deepEqual(stdoutChunks, ["hello ", "world", "\n"]);
  });

  it("streams deltas raw when renderMarkdown is explicitly off, even on a TTY", () => {
    captureStdout(true);
    const fmt = makeTextFormatter({ verbose: false, renderMarkdown: false });

    fmt.emitter.emit(deltaEvent("**bold**"));
    assert.deepEqual(stdoutChunks, ["**bold**"]);

    fmt.emitter.emit(completeEvent());
    assert.deepEqual(stdoutChunks, ["**bold**", "\n"]);
  });
});
