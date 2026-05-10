/**
 * tests/coding-tools-readonly.test.ts
 *
 * Read-only coding tools — read_file, list_dir, glob, grep. No spawn,
 * no network. Each test sets up a tmp directory, populates fixtures,
 * invokes the tool's handler directly, and inspects the result.
 *
 * What we pin per tool:
 *   - read_file: line-prefix output, paging, binary refusal,
 *     directory refusal, missing-file error.
 *   - list_dir : non-recursive default, recursive + depth, default
 *     ignore set, include_hidden override.
 *   - glob     : pattern + cwd, mtime sort, ignore set, no-match.
 *   - grep     : files_with_matches / count / content modes, glob
 *     filter, type filter, ignore_case, A/B/C context, head_limit
 *     truncation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Side-effect: register tools.
import "../server/task/tools/index.js";
import { getTool } from "../server/task/tools/registry.js";
import type { TaskContext } from "../server/engine/TaskContext.js";

// Tools never touch TaskContext for read-only operations — pass an
// empty stub.
const stubCtx = {} as unknown as TaskContext;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "huko-coding-tools-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── read_file ──────────────────────────────────────────────────────────────

describe("read_file", () => {
  it("returns numbered lines for a small text file", async () => {
    const p = join(tmp, "hello.txt");
    writeFileSync(p, "alpha\nbeta\ngamma\n", "utf8");
    const out = await invokeTool("read_file", { path: p });
    assert.match(out.content, /^1\talpha/m);
    assert.match(out.content, /^2\tbeta/m);
    assert.match(out.content, /^3\tgamma/m);
  });

  it("supports offset + limit paging", async () => {
    const p = join(tmp, "long.txt");
    writeFileSync(p, Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"), "utf8");
    const out = await invokeTool("read_file", { path: p, offset: 10, limit: 3 });
    assert.match(out.content, /^10\tline10/m);
    assert.match(out.content, /^12\tline12/m);
    assert.doesNotMatch(out.content, /^9\t/m);
    assert.doesNotMatch(out.content, /^13\t/m);
  });

  it("flags empty files explicitly", async () => {
    const p = join(tmp, "empty.txt");
    writeFileSync(p, "", "utf8");
    const out = await invokeTool("read_file", { path: p });
    assert.match(out.content, /empty/i);
  });

  it("refuses binary files", async () => {
    const p = join(tmp, "image.bin");
    writeFileSync(p, Buffer.from([0, 1, 2, 3, 0, 0, 0, 0xff, 0xfe]));
    const out = await invokeTool("read_file", { path: p });
    assert.equal(out.error, "binary content");
  });

  it("refuses directories", async () => {
    const out = await invokeTool("read_file", { path: tmp });
    assert.equal(out.error, "is directory");
  });

  it("returns a clean stat-failed error for missing files", async () => {
    const out = await invokeTool("read_file", { path: join(tmp, "nope.txt") });
    assert.equal(out.error, "stat failed");
  });
});

// ─── list_dir ───────────────────────────────────────────────────────────────

describe("list_dir", () => {
  it("non-recursive: lists direct children only", async () => {
    writeFileSync(join(tmp, "a.txt"), "x", "utf8");
    writeFileSync(join(tmp, "b.txt"), "x", "utf8");
    mkdirSync(join(tmp, "sub"));
    writeFileSync(join(tmp, "sub", "deep.txt"), "x", "utf8");
    const out = await invokeTool("list_dir", { path: tmp });
    assert.match(out.content, /a\.txt/);
    assert.match(out.content, /b\.txt/);
    assert.match(out.content, /sub/);
    assert.doesNotMatch(out.content, /deep\.txt/);
  });

  it("recursive: descends and uses forward-slash paths", async () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "x.ts"), "x", "utf8");
    const out = await invokeTool("list_dir", { path: tmp, recursive: true });
    assert.match(out.content, /src\/x\.ts/);
  });

  it("skips default-ignored dirs (node_modules, .git) by default", async () => {
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, "node_modules", "garbage.json"), "{}", "utf8");
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, ".git", "HEAD"), "ref", "utf8");
    writeFileSync(join(tmp, "real.ts"), "x", "utf8");
    const out = await invokeTool("list_dir", { path: tmp });
    assert.match(out.content, /real\.ts/);
    assert.doesNotMatch(out.content, /node_modules/);
    assert.doesNotMatch(out.content, /\.git/);
  });

  it("include_hidden=true surfaces them again", async () => {
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, ".env"), "X=1", "utf8");
    const out = await invokeTool("list_dir", { path: tmp, include_hidden: true });
    assert.match(out.content, /node_modules/);
    assert.match(out.content, /\.env/);
  });

  it("refuses non-directory paths", async () => {
    const p = join(tmp, "f.txt");
    writeFileSync(p, "x", "utf8");
    const out = await invokeTool("list_dir", { path: p });
    assert.equal(out.error, "not a directory");
  });
});

// ─── glob ───────────────────────────────────────────────────────────────────

describe("glob", () => {
  it("matches a simple pattern", async () => {
    writeFileSync(join(tmp, "a.ts"), "x", "utf8");
    writeFileSync(join(tmp, "b.ts"), "x", "utf8");
    writeFileSync(join(tmp, "c.js"), "x", "utf8");
    const out = await invokeTool("glob", { pattern: "*.ts", cwd: tmp });
    const lines = out.content.split("\n");
    assert.equal(lines.filter((l: string) => l.endsWith("a.ts")).length, 1);
    assert.equal(lines.filter((l: string) => l.endsWith("b.ts")).length, 1);
    assert.equal(lines.filter((l: string) => l.endsWith("c.js")).length, 0);
  });

  it("supports ** for any depth", async () => {
    mkdirSync(join(tmp, "src", "deep", "sub"), { recursive: true });
    writeFileSync(join(tmp, "src", "deep", "sub", "leaf.ts"), "x", "utf8");
    const out = await invokeTool("glob", { pattern: "**/*.ts", cwd: tmp });
    assert.match(out.content, /leaf\.ts/);
  });

  it("returns mtime-desc order — newest first", async () => {
    const old = join(tmp, "old.ts");
    const fresh = join(tmp, "fresh.ts");
    writeFileSync(old, "x", "utf8");
    writeFileSync(fresh, "x", "utf8");
    // Backdate `old` by ~10 seconds to make ordering deterministic on
    // filesystems with second-resolution mtime (HFS+, FAT, some NFS).
    const past = new Date(Date.now() - 10_000);
    utimesSync(old, past, past);
    const out = await invokeTool("glob", { pattern: "*.ts", cwd: tmp });
    const lines = out.content.split("\n").filter((l: string) => l.endsWith(".ts"));
    assert.match(lines[0]!, /fresh\.ts/);
    assert.match(lines[1]!, /old\.ts/);
  });

  it("excludes node_modules by default", async () => {
    mkdirSync(join(tmp, "node_modules", "evil"), { recursive: true });
    writeFileSync(join(tmp, "node_modules", "evil", "x.ts"), "x", "utf8");
    writeFileSync(join(tmp, "real.ts"), "x", "utf8");
    const out = await invokeTool("glob", { pattern: "**/*.ts", cwd: tmp });
    assert.match(out.content, /real\.ts/);
    assert.doesNotMatch(out.content, /node_modules/);
  });

  it("reports zero matches cleanly", async () => {
    const out = await invokeTool("glob", { pattern: "*.never", cwd: tmp });
    assert.match(out.content, /No files matched/);
  });
});

// ─── grep ───────────────────────────────────────────────────────────────────

describe("grep", () => {
  it("files_with_matches mode lists paths", async () => {
    writeFileSync(join(tmp, "a.ts"), "function foo() {}\n", "utf8");
    writeFileSync(join(tmp, "b.ts"), "// no match\n", "utf8");
    const out = await invokeTool("grep", { pattern: "foo", path: tmp });
    assert.match(out.content, /a\.ts/);
    assert.doesNotMatch(out.content, /b\.ts/);
  });

  it("count mode reports per-file counts", async () => {
    writeFileSync(join(tmp, "x.ts"), "foo\nfoo\nbar\nfoo\n", "utf8");
    const out = await invokeTool("grep", { pattern: "foo", path: tmp, output_mode: "count" });
    assert.match(out.content, /3\t.*x\.ts/);
  });

  it("content mode returns matching lines with optional line numbers", async () => {
    writeFileSync(join(tmp, "x.ts"), "alpha\nfoo here\ngamma\n", "utf8");
    const out = await invokeTool("grep", {
      pattern: "foo",
      path: tmp,
      output_mode: "content",
      n: true,
    });
    assert.match(out.content, /\s+2:\s+foo here/);
  });

  it("supports ignore_case", async () => {
    writeFileSync(join(tmp, "x.ts"), "FOO\n", "utf8");
    const insensitive = await invokeTool("grep", {
      pattern: "foo",
      path: tmp,
      ignore_case: true,
    });
    assert.match(insensitive.content, /x\.ts/);
    const sensitive = await invokeTool("grep", { pattern: "foo", path: tmp });
    assert.match(sensitive.content, /No matches/);
  });

  it("type filter scopes to known extensions", async () => {
    writeFileSync(join(tmp, "x.ts"), "foo\n", "utf8");
    writeFileSync(join(tmp, "y.py"), "foo\n", "utf8");
    const onlyTs = await invokeTool("grep", { pattern: "foo", path: tmp, type: "ts" });
    assert.match(onlyTs.content, /x\.ts/);
    assert.doesNotMatch(onlyTs.content, /y\.py/);
  });

  it("rejects unknown type values loud", async () => {
    const out = await invokeTool("grep", { pattern: "foo", path: tmp, type: "cobol" });
    assert.equal(out.error, "unknown type");
  });

  it("A/B/C context expands content mode output", async () => {
    writeFileSync(
      join(tmp, "x.ts"),
      "before2\nbefore1\nMATCH\nafter1\nafter2\n",
      "utf8",
    );
    const out = await invokeTool("grep", {
      pattern: "MATCH",
      path: tmp,
      output_mode: "content",
      C: 1,
      n: true,
    });
    assert.match(out.content, /\s+2-\s+before1/);
    assert.match(out.content, /\s+3:\s+MATCH/);
    assert.match(out.content, /\s+4-\s+after1/);
    assert.doesNotMatch(out.content, /\s+1-\s+before2/);
  });

  it("head_limit truncates results with a notice", async () => {
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(tmp, `f${i}.ts`), "foo\n", "utf8");
    }
    const out = await invokeTool("grep", {
      pattern: "foo",
      path: tmp,
      head_limit: 5,
    });
    const lines = out.content.split("\n").filter((l: string) => l.endsWith(".ts"));
    assert.equal(lines.length, 5);
    assert.match(out.content, /truncated/i);
  });

  it("invalid regex returns a clean error", async () => {
    const out = await invokeTool("grep", { pattern: "foo[", path: tmp });
    assert.equal(out.error, "invalid regex");
  });
});

// ─── helper ──────────────────────────────────────────────────────────────────

async function invokeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; error?: string | null; metadata?: Record<string, unknown> }> {
  const tool = getTool(name);
  if (!tool || tool.kind !== "server") throw new Error(`tool ${name} not registered`);
  const r = await Promise.resolve(tool.handler(args, stubCtx, { toolCallId: "test" }));
  if (typeof r === "string") return { content: r, error: null };
  if ("content" in r) {
    const out: { content: string; error?: string | null; metadata?: Record<string, unknown> } = {
      content: r.content,
    };
    if ("error" in r) out.error = r.error ?? null;
    if ("metadata" in r) out.metadata = r.metadata;
    return out;
  }
  // Legacy ServerToolResult
  return { content: r.result, error: r.error ?? null };
}
