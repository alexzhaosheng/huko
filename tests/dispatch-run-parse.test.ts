/**
 * tests/dispatch-run-parse.test.ts
 *
 * Pure unit tests for `parseRunArgs` — the strict `--` sentinel argv
 * parser for `huko run`.
 *
 * Coverage:
 *   - ok: flag-only left side + verbatim right side
 *   - ok: flag order is free
 *   - ok: prompt may contain `--foo`, `-bar`, and stray `--` after first
 *   - ok: --json / --jsonl / --format= shortcut handling
 *   - ok: --session= integer validation
 *   - error: positional before sentinel
 *   - error: missing sentinel
 *   - error: empty prompt after sentinel
 *   - error: unknown flag
 *   - error: --new and --session= mutually exclusive
 *   - help: -h / --help short-circuits
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseRunArgs } from "../server/cli/dispatch/run.js";

// ─── ok cases ───────────────────────────────────────────────────────────────

describe("parseRunArgs — happy path", () => {
  it("parses just a prompt with no flags", () => {
    const r = parseRunArgs(["--", "hello", "world"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "hello world");
    assert.equal(r.args.format, "text");
  });

  it("parses flags before the sentinel + prompt after", () => {
    const r = parseRunArgs(["--new", "--title=foo", "--memory", "--", "hello"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "hello");
    assert.equal(r.args.newSession, true);
    assert.equal(r.args.title, "foo");
    assert.equal(r.args.ephemeral, true);
  });

  it("treats flag order as irrelevant", () => {
    const a = parseRunArgs(["--new", "--memory", "--", "hi"]);
    const b = parseRunArgs(["--memory", "--new", "--", "hi"]);
    assert.deepEqual(a, b);
  });

  it("preserves --foo verbatim inside the prompt", () => {
    const r = parseRunArgs(["--new", "--", "explain", "--metric", "correctness"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "explain --metric correctness");
  });

  it("only the FIRST `--` is the sentinel; later ones are prompt content", () => {
    const r = parseRunArgs(["--", "use", "--", "as", "separator"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "use -- as separator");
  });

  it("handles --json / --jsonl shortcuts", () => {
    const a = parseRunArgs(["--json", "--", "hi"]);
    assert.equal(a.kind, "ok");
    if (a.kind === "ok") assert.equal(a.args.format, "json");

    const b = parseRunArgs(["--jsonl", "--", "hi"]);
    assert.equal(b.kind, "ok");
    if (b.kind === "ok") assert.equal(b.args.format, "jsonl");
  });

  it("handles --format=<fmt>", () => {
    const r = parseRunArgs(["--format=json", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.args.format, "json");
  });

  it("parses --session=<positive int>", () => {
    const r = parseRunArgs(["--session=42", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.args.sessionId, 42);
  });

  it("parses --no-interaction (long form) and -y (short)", () => {
    const a = parseRunArgs(["--no-interaction", "--", "hi"]);
    assert.equal(a.kind, "ok");
    if (a.kind === "ok") assert.equal(a.args.interactive, false);

    const b = parseRunArgs(["-y", "--", "hi"]);
    assert.equal(b.kind, "ok");
    if (b.kind === "ok") assert.equal(b.args.interactive, false);
  });

  it("parses --show-tokens", () => {
    const r = parseRunArgs(["--show-tokens", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.args.showTokens, true);
  });

  it("collapses prompt tokens with single spaces (no preservation of double whitespace)", () => {
    // The shell tokeniser strips/collapses whitespace BEFORE we see argv,
    // so this is the contract we can offer: one space between tokens.
    const r = parseRunArgs(["--", "a", "b", "c"]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.args.prompt, "a b c");
  });

  it("preserves non-ASCII content unchanged", () => {
    const r = parseRunArgs(["--new", "--", "检查", "huko", "代码"]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.args.prompt, "检查 huko 代码");
  });
});

// ─── error cases — argv shape ───────────────────────────────────────────────

describe("parseRunArgs — protocol enforcement", () => {
  it("rejects a bare positional before the sentinel", () => {
    const r = parseRunArgs(["hello", "world"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /positional argument "hello" is not allowed/);
    // The error suggests the corrected form.
    assert.match(r.message, /huko run.*-- hello/);
  });

  it("rejects a positional after a recognised flag but before sentinel", () => {
    const r = parseRunArgs(["--new", "hello"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /"hello" is not allowed before/);
  });

  it("rejects missing sentinel (no `--` token anywhere)", () => {
    const r = parseRunArgs(["--new", "--memory"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /prompt is required/);
    assert.match(r.message, /Use `--`/);
  });

  it("rejects empty argv", () => {
    const r = parseRunArgs([]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /prompt is required/);
  });

  it("rejects empty prompt after sentinel", () => {
    const r = parseRunArgs(["--new", "--"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /empty prompt/);
  });

  it("rejects whitespace-only prompt after sentinel", () => {
    // After shell tokenisation, all-whitespace args would be empty
    // strings — we still want to treat join().trim()==="" as empty.
    const r = parseRunArgs(["--", "", "  ", ""]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /empty prompt/);
  });

  it("rejects an unknown flag on the left side", () => {
    const r = parseRunArgs(["--definitely-not-a-flag", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unknown flag: --definitely-not-a-flag/);
  });

  it("rejects an invalid --session= value", () => {
    const r = parseRunArgs(["--session=abc", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /invalid --session value: abc/);
  });

  it("rejects a non-positive --session=", () => {
    const r = parseRunArgs(["--session=0", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /invalid --session/);
  });

  it("rejects an invalid --format= value", () => {
    const r = parseRunArgs(["--format=xml", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /invalid --format value: xml/);
  });

  it("rejects --new combined with --session=<id>", () => {
    const r = parseRunArgs(["--new", "--session=5", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /mutually exclusive/);
  });
});

// ─── help short-circuit ─────────────────────────────────────────────────────

describe("parseRunArgs — help short-circuit", () => {
  it("returns help when -h appears (even with other args)", () => {
    const r = parseRunArgs(["--new", "-h", "--", "hi"]);
    assert.equal(r.kind, "help");
  });

  it("returns help when --help appears", () => {
    const r = parseRunArgs(["--help"]);
    assert.equal(r.kind, "help");
  });

  it("does NOT treat -h after the sentinel as help (it's prompt content)", () => {
    const r = parseRunArgs(["--", "what", "does", "-h", "do"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "what does -h do");
  });
});
