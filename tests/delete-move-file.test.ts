/**
 * tests/delete-move-file.test.ts
 *
 * Coverage:
 *   - delete_file: deletes a regular file
 *   - delete_file: refuses a directory without recursive
 *   - delete_file: deletes a directory tree with recursive: true
 *   - delete_file: clear error on missing path
 *   - delete_file: rejects empty / missing path arg
 *   - move_file: moves a file (rename within same dir)
 *   - move_file: refuses if target exists without overwrite
 *   - move_file: overwrites with overwrite: true
 *   - move_file: refuses if source missing
 *   - move_file: moves a directory tree
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Side-effect: register tools.
import "../server/task/tools/index.js";
import { getTool, type ToolHandlerResult } from "../server/task/tools/registry.js";
import type { TaskContext } from "../server/engine/TaskContext.js";

const stubCtx = {} as unknown as TaskContext;

async function call(name: string, args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const tool = getTool(name);
  if (!tool || tool.kind !== "server") throw new Error(`${name} not registered`);
  const r = await Promise.resolve(tool.handler(args, stubCtx, { toolCallId: "t" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) return r as ToolHandlerResult;
  return { content: r.result, error: r.error ?? null };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "huko-fileops-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── delete_file ────────────────────────────────────────────────────────────

describe("delete_file", () => {
  it("deletes a regular file", async () => {
    const p = join(tmp, "doomed.txt");
    writeFileSync(p, "bye", "utf8");
    const r = await call("delete_file", { path: p });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(!existsSync(p));
  });

  it("refuses a directory without recursive", async () => {
    const d = join(tmp, "subdir");
    mkdirSync(d);
    writeFileSync(join(d, "child.txt"), "hi", "utf8");
    const r = await call("delete_file", { path: d });
    assert.ok(r.error);
    assert.match(r.content, /directory/);
    assert.ok(existsSync(d), "directory should NOT have been removed");
  });

  it("deletes a directory tree when recursive=true", async () => {
    const d = join(tmp, "wipe");
    mkdirSync(d);
    writeFileSync(join(d, "a.txt"), "a", "utf8");
    mkdirSync(join(d, "nested"));
    writeFileSync(join(d, "nested", "b.txt"), "b", "utf8");
    const r = await call("delete_file", { path: d, recursive: true });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(!existsSync(d));
  });

  it("returns clear error on missing path", async () => {
    const r = await call("delete_file", { path: join(tmp, "ghost.txt") });
    assert.ok(r.error);
    assert.match(r.content, /No such file/);
  });

  it("rejects empty path arg", async () => {
    const r = await call("delete_file", { path: "" });
    assert.ok(r.error);
    assert.match(r.content, /path is required/i);
  });
});

// ─── move_file ──────────────────────────────────────────────────────────────

describe("move_file", () => {
  it("moves a file within the same directory (rename)", async () => {
    const src = join(tmp, "old.txt");
    const tgt = join(tmp, "new.txt");
    writeFileSync(src, "content", "utf8");
    const r = await call("move_file", { source: src, target: tgt });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(!existsSync(src));
    assert.ok(existsSync(tgt));
    assert.equal(readFileSync(tgt, "utf8"), "content");
  });

  it("refuses if target exists without overwrite", async () => {
    const src = join(tmp, "src.txt");
    const tgt = join(tmp, "tgt.txt");
    writeFileSync(src, "src body", "utf8");
    writeFileSync(tgt, "tgt body", "utf8");
    const r = await call("move_file", { source: src, target: tgt });
    assert.ok(r.error);
    assert.match(r.content, /Target already exists/);
    // Both files unchanged.
    assert.equal(readFileSync(src, "utf8"), "src body");
    assert.equal(readFileSync(tgt, "utf8"), "tgt body");
  });

  it("overwrites with overwrite=true", async () => {
    const src = join(tmp, "src.txt");
    const tgt = join(tmp, "tgt.txt");
    writeFileSync(src, "fresh", "utf8");
    writeFileSync(tgt, "stale", "utf8");
    const r = await call("move_file", { source: src, target: tgt, overwrite: true });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(!existsSync(src));
    assert.equal(readFileSync(tgt, "utf8"), "fresh");
  });

  it("refuses if source missing", async () => {
    const r = await call("move_file", {
      source: join(tmp, "ghost"),
      target: join(tmp, "anywhere"),
    });
    assert.ok(r.error);
    assert.match(r.content, /Source does not exist/);
  });

  it("moves a directory tree", async () => {
    const srcDir = join(tmp, "srcdir");
    const tgtDir = join(tmp, "tgtdir");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "inner.txt"), "inside", "utf8");
    const r = await call("move_file", { source: srcDir, target: tgtDir });
    assert.equal(r.error ?? null, null, r.content);
    assert.ok(!existsSync(srcDir));
    assert.equal(readFileSync(join(tgtDir, "inner.txt"), "utf8"), "inside");
  });

  it("rejects empty source / target", async () => {
    let r = await call("move_file", { source: "", target: "/x" });
    assert.ok(r.error);
    r = await call("move_file", { source: "/x", target: "" });
    assert.ok(r.error);
  });
});
