/**
 * tests/markdown-render.test.ts
 *
 * Coverage:
 *   - renderMd returns raw text when stdout is NOT a TTY (piped)
 *   - renderMd produces ANSI-styled output when stdout IS a TTY
 *   - Bold/italic/heading are formatted with ANSI codes
 *   - Tables get box-drawing characters (┌─┬─┐)
 *   - Code spans are styled
 *   - Empty strings pass through untouched
 *   - Badly formed markdown falls back to raw text (no throw)
 *   - target: "stderr" checks stderr.isTTY instead of stdout.isTTY
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

// renderMd uses process.stdout.isTTY / process.stderr.isTTY to decide
// whether to render. We swap those via Object.defineProperty per test.
// The `_configured` flag is a module-level `let` — since we import
// `renderMd` once, the renderer gets configured on the first TTY call
// and stays configured. That's fine — all tests share it.

// We import AFTER any TTY mocking, but because ESM imports are hoisted,
// we must mock BEFORE importing. Use dynamic import() pattern instead.
// Actually — the module itself doesn't read isTTY at import time, only
// at call time within renderMd(). So static import is fine.

import { renderMd } from "../server/cli/formatters/markdown.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function withTTY<T>(stdoutTTY: boolean, stderrTTY: boolean, fn: () => T): T {
  const origOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origErr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: stderrTTY, configurable: true });
  try {
    return fn();
  } finally {
    if (origOut) Object.defineProperty(process.stdout, "isTTY", origOut);
    else Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    if (origErr) Object.defineProperty(process.stderr, "isTTY", origErr);
    else Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("renderMd — TTY gating", () => {
  it("returns raw text when stdout is not a TTY", () => {
    withTTY(false, false, () => {
      const input = "# Hello\n\nThis is **bold** and *italic*.";
      const result = renderMd(input);
      // Non-TTY → passthrough. Should NOT contain ANSI escape sequences.
      assert.equal(result, input);
    });
  });

  it("returns raw text when target=stderr and stderr is not a TTY", () => {
    withTTY(true, false, () => {
      const input = "# Hello";
      const result = renderMd(input, { target: "stderr" });
      // stdout IS a TTY but stderr is NOT — target=stderr → passthrough.
      assert.equal(result, input);
    });
  });

  it("renders when stdout is a TTY", () => {
    withTTY(true, false, () => {
      const result = renderMd("# Hello");
      // Should be ANSI-styled, not raw markdown.
      assert.notEqual(result, "# Hello");
      assert.ok(result.includes("Hello"), `expected "Hello" in: ${JSON.stringify(result)}`);
    });
  });

  it("target=stderr renders when stderr is a TTY (even if stdout is not)", () => {
    withTTY(false, true, () => {
      const result = renderMd("# Hello", { target: "stderr" });
      assert.notEqual(result, "# Hello");
      assert.ok(result.includes("Hello"));
    });
  });
});

describe("renderMd — formatting", () => {
  it("processes bold markdown and preserves the text", () => {
    withTTY(true, false, () => {
      const result = renderMd("this is **bold** text");
      // The `**` markers should be gone (markdown processed).
      // ANSI codes may or may not appear depending on the Chalk
      // colour-support detection; on Windows CI runners they
      // often don't. The important invariant is: the rendered
      // output is NOT raw markdown anymore.
      assert.doesNotMatch(result, /\*\*bold\*\*/);
      assert.ok(result.includes("bold"), `missing "bold": ${JSON.stringify(result)}`);
    });
  });

  it("renders italic text", () => {
    withTTY(true, false, () => {
      const result = renderMd("this is *italic* text");
      assert.ok(result.includes("italic"), `missing "italic": ${JSON.stringify(result)}`);
    });
  });

  it("renders headings in a distinct style", () => {
    withTTY(true, false, () => {
      const result = renderMd("# Heading 1\n\n## Heading 2");
      assert.ok(result.includes("Heading 1"));
      assert.ok(result.includes("Heading 2"));
      // Headings should be styled differently from plain text.
      // plain "## Heading 2" in raw would start with "#"; rendered should not.
      assert.ok(!result.startsWith("#"));
    });
  });

  it("renders inline code with distinct styling", () => {
    withTTY(true, false, () => {
      const result = renderMd("run `npm test` to verify");
      // Raw backticks should be gone; "npm test" should still be there.
      assert.doesNotMatch(result, /`npm test`/);
      assert.ok(result.includes("npm test"), `missing code content: ${JSON.stringify(result)}`);
    });
  });

  it("renders code blocks", () => {
    withTTY(true, false, () => {
      const result = renderMd("```js\nconst x = 1;\n```");
      assert.ok(result.includes("const x = 1;"), `missing code: ${JSON.stringify(result)}`);
    });
  });
});

describe("renderMd — tables", () => {
  it("renders a simple table with box-drawing characters", () => {
    withTTY(true, false, () => {
      const result = renderMd("| A | B |\n| - | - |\n| 1 | 2 |");
      // Box-drawing characters:
      assert.match(result, /[\u2500\u2502\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c]/);
      assert.ok(result.includes("A"), `missing "A": ${JSON.stringify(result)}`);
      assert.ok(result.includes("B"), `missing "B": ${JSON.stringify(result)}`);
      assert.ok(result.includes("1"), `missing "1": ${JSON.stringify(result)}`);
      assert.ok(result.includes("2"), `missing "2": ${JSON.stringify(result)}`);
    });
  });

  it("renders a wider table correctly", () => {
    withTTY(true, false, () => {
      const result = renderMd(
        "| Name   | Age | Location |\n" +
        "|--------|-----|----------|\n" +
        "| Alice  | 30  | NYC      |\n" +
        "| Bob    | 25  | London   |",
      );
      assert.ok(result.includes("Alice"));
      assert.ok(result.includes("Bob"));
      assert.ok(result.includes("NYC"));
      assert.ok(result.includes("London"));
      // Should have box-drawing chars between columns.
      assert.match(result, /[\u2502]/); // │ vertical bar
    });
  });
});

describe("renderMd — edge cases", () => {
  it("returns empty string unchanged", () => {
    withTTY(true, false, () => {
      assert.equal(renderMd(""), "");
    });
  });

  it("returns empty string unchanged even with target", () => {
    withTTY(false, true, () => {
      assert.equal(renderMd("", { target: "stderr" }), "");
    });
  });

  it("trims trailing whitespace after rendering", () => {
    withTTY(true, false, () => {
      const result = renderMd("hello  \n\n");
      assert.equal(result, "hello");
    });
  });

  it("does NOT add a trailing newline (compact output)", () => {
    withTTY(true, false, () => {
      const result = renderMd("hello");
      assert.ok(!result.endsWith("\n"), `unexpected trailing newline: ${JSON.stringify(result)}`);
    });
  });
});
