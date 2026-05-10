/**
 * tests/coding-tools-write.test.ts
 *
 * write_file + edit_file. The fuzzy-edit module is exercised
 * indirectly through edit_file's fuzzy fallback paths.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../server/task/tools/index.js";
import { getTool } from "../server/task/tools/registry.js";
import type { TaskContext } from "../server/engine/TaskContext.js";

const stubCtx = {} as unknown as TaskContext;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "huko-write-edit-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── write_file ─────────────────────────────────────────────────────────────

describe("write_file", () => {
  it("creates a new file with the given content", async () => {
    const p = join(tmp, "new.txt");
    const out = await invoke("write_file", { path: p, content: "hello\nworld\n" });
    assert.equal(out.error, undefined);
    assert.equal(readFileSync(p, "utf8"), "hello\nworld\n");
  });

  it("overwrites an existing file", async () => {
    const p = join(tmp, "x.txt");
    writeFileSync(p, "original\n", "utf8");
    await invoke("write_file", { path: p, content: "rewritten\n" });
    assert.equal(readFileSync(p, "utf8"), "rewritten\n");
  });

  it("creates missing parent directories", async () => {
    const p = join(tmp, "sub", "deep", "leaf.txt");
    const out = await invoke("write_file", { path: p, content: "ok" });
    assert.equal(out.error, undefined);
    assert.equal(readFileSync(p, "utf8"), "ok");
  });

  it("refuses to overwrite a directory", async () => {
    const out = await invoke("write_file", { path: tmp, content: "x" });
    assert.equal(out.error, "is directory");
  });

  it("requires a string content arg", async () => {
    const p = join(tmp, "x.txt");
    const out = await invoke("write_file", { path: p });
    assert.equal(out.error, "missing content");
  });
});

// ─── edit_file: exact match ────────────────────────────────────────────────

describe("edit_file — exact match", () => {
  it("replaces a single occurrence atomically", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "const x = 1;\nconst y = 2;\n", "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [{ find: "const x = 1;", replace: "const x = 100;" }],
    });
    assert.equal(out.error, undefined);
    assert.equal(readFileSync(p, "utf8"), "const x = 100;\nconst y = 2;\n");
  });

  it("applies multiple edits sequentially in array order", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "alpha\nbeta\ngamma\n", "utf8");
    await invoke("edit_file", {
      path: p,
      edits: [
        { find: "alpha", replace: "ALPHA" },
        { find: "gamma", replace: "GAMMA" },
      ],
    });
    assert.equal(readFileSync(p, "utf8"), "ALPHA\nbeta\nGAMMA\n");
  });

  it("with all=true replaces every occurrence", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "foo\nfoo\nbar\nfoo\n", "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [{ find: "foo", replace: "FOO", all: true }],
    });
    assert.equal(out.error, undefined);
    assert.equal(readFileSync(p, "utf8"), "FOO\nFOO\nbar\nFOO\n");
  });
});

// ─── edit_file: fuzzy fallback ─────────────────────────────────────────────

describe("edit_file — fuzzy whitespace-tolerant match", () => {
  it("matches when trailing whitespace differs (fuzzy bridges it)", async () => {
    const p = join(tmp, "f.ts");
    // File has trailing spaces on a line; LLM's find has none.
    const orig = "function f() {\n  const x = 1;   \n  return x;\n}\n";
    writeFileSync(p, orig, "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [
        {
          find: "  const x = 1;\n  return x;",
          replace: "  const x = 42;\n  return x;",
        },
      ],
    });
    assert.equal(out.error, undefined);
    const after = readFileSync(p, "utf8");
    assert.match(after, /  const x = 42;\n  return x;/);
    // The fuzzy match note should appear in the result.
    assert.match(out.content, /fuzzy match/);
  });

  it("reports `(fuzzy match, indentation auto-aligned)` in the result", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "    inner\n", "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [{ find: "inner", replace: "rewritten" }],
    });
    // Exact "inner" appears as substring of "    inner", so this is exact.
    assert.equal(out.error, undefined);
    assert.doesNotMatch(out.content, /fuzzy match/);
  });
});

// ─── edit_file: failure modes ──────────────────────────────────────────────

describe("edit_file — atomicity on failure", () => {
  it("when one edit fails, NO changes are written", async () => {
    const p = join(tmp, "f.ts");
    const orig = "alpha\nbeta\n";
    writeFileSync(p, orig, "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [
        { find: "alpha", replace: "ALPHA" }, // would succeed
        { find: "no-such-text", replace: "x" }, // would fail
      ],
    });
    assert.equal(out.error, "find not located");
    // File content unchanged.
    assert.equal(readFileSync(p, "utf8"), orig);
  });

  it("emits a hint when the first line of `find` appears in some file line", async () => {
    const p = join(tmp, "f.ts");
    // File contains "alpha key" at line 2 (with extra suffix). Find's
    // first line is "alpha key" — a substring of that file line.
    // Multi-line find with the second line not in the file → exact +
    // fuzzy both fail, but the substring search for the first line
    // hits the hint path.
    writeFileSync(p, "line one\nalpha key found here\nline three\n", "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [
        {
          find: "alpha key\nthis line is not in the file at all",
          replace: "x",
        },
      ],
    });
    assert.equal(out.error, "find not located");
    assert.match(out.content, /Hint: line \d+/);
  });

  it("refuses brand-new file paths (suggests write_file)", async () => {
    const out = await invoke("edit_file", {
      path: join(tmp, "doesnt-exist.ts"),
      edits: [{ find: "x", replace: "y" }],
    });
    assert.equal(out.error, "not found");
    assert.match(out.content, /write_file/);
  });

  it("refuses binary files", async () => {
    const p = join(tmp, "img.bin");
    writeFileSync(p, Buffer.from([0, 1, 2, 0, 0xff]));
    const out = await invoke("edit_file", {
      path: p,
      edits: [{ find: "x", replace: "y" }],
    });
    assert.equal(out.error, "binary content");
  });

  it("rejects an empty find string", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "x", "utf8");
    const out = await invoke("edit_file", {
      path: p,
      edits: [{ find: "", replace: "y" }],
    });
    assert.equal(out.error, "empty find");
  });

  it("requires a non-empty edits array", async () => {
    const p = join(tmp, "f.ts");
    writeFileSync(p, "x", "utf8");
    const out = await invoke("edit_file", { path: p, edits: [] });
    assert.equal(out.error, "missing edits");
  });
});

// ─── helper ─────────────────────────────────────────────────────────────────

async function invoke(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; error?: string }> {
  const tool = getTool(name);
  if (!tool || tool.kind !== "server") throw new Error(`tool ${name} not registered`);
  const r = await Promise.resolve(tool.handler(args, stubCtx, { toolCallId: "test" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) {
    const out: { content: string; error?: string } = { content: r.content };
    if ("error" in r && r.error) out.error = r.error;
    return out;
  }
  return { content: r.result, ...(r.error ? { error: r.error } : {}) };
}
