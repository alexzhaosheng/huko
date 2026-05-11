/**
 * tests/dispatch-run-parse.test.ts
 *
 * Unit tests for `parseRunArgs` — the prompt-pipeline argv parser.
 *
 * Parser contract (mirrors dispatch/run.ts header docs):
 *   - Walk argv left-to-right.
 *   - Tokens starting with `-` while in flag mode → recognised flag, or
 *     error if unknown.
 *   - `--` switches to prompt mode (sentinel itself is dropped); every
 *     subsequent token is prompt content, verbatim — including things
 *     that look like flags.
 *   - A bare (non-flag) positional in flag mode is a parse error. Prompt
 *     content MUST be introduced by `--`. This keeps "first bare word"
 *     unambiguously a subcommand-selector slot at the index.ts layer.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseRunArgs } from "../server/cli/dispatch/run.js";

// ─── ok cases ───────────────────────────────────────────────────────────────

describe("parseRunArgs — happy path", () => {
  it("prompt after `--` (the canonical form)", () => {
    const r = parseRunArgs(["--", "fix", "the", "bug"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "fix the bug");
    assert.equal(r.args.format, "text");
  });

  it("flags followed by `--` then prompt", () => {
    const r = parseRunArgs(["--new", "--title=foo", "--memory", "--", "fix", "the", "bug"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "fix the bug");
    assert.equal(r.args.newSession, true);
    assert.equal(r.args.title, "foo");
    assert.equal(r.args.ephemeral, true);
  });

  it("`--` sentinel works for prompts starting with -", () => {
    const r = parseRunArgs(["--", "-3", "+", "5"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "-3 + 5");
  });

  it("after sentinel, --foo is prompt content, not flag", () => {
    const r = parseRunArgs(["--new", "--", "--metric", "correctness"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "--metric correctness");
    assert.equal(r.args.newSession, true);
  });

  it("after sentinel, prompt may contain --no-interaction etc verbatim", () => {
    const r = parseRunArgs(["--new", "--", "explain", "--no-interaction", "behavior"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "explain --no-interaction behavior");
    assert.equal(r.args.newSession, true);
    // --no-interaction was prompt content; interactive stays at default
    assert.notEqual(r.args.interactive, false);
  });

  it("flag order is free", () => {
    const a = parseRunArgs(["--new", "--memory", "--", "hi"]);
    const b = parseRunArgs(["--memory", "--new", "--", "hi"]);
    assert.deepEqual(a, b);
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

  it("collapses prompt tokens with single spaces", () => {
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

// ─── lean / full / verbose / quiet ──────────────────────────────────────────

describe("parseRunArgs — mode + verbosity flags", () => {
  it("parses --lean → mode 'lean'", () => {
    const r = parseRunArgs(["--lean", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.mode, "lean");
  });

  it("--full is no longer a flag (full is the default; opt-in is only --lean)", () => {
    const r = parseRunArgs(["--full", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unknown flag: --full/);
  });

  it("parses --verbose → verbose: true", () => {
    const r = parseRunArgs(["--verbose", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.verbose, true);
  });

  it("parses -v short form", () => {
    const r = parseRunArgs(["-v", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.verbose, true);
  });

  it("parses --quiet → verbose: false (forcing override)", () => {
    const r = parseRunArgs(["--quiet", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.verbose, false);
  });

  it("omits mode + verbose when neither is given (lets config decide)", () => {
    const r = parseRunArgs(["--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.mode, undefined);
    assert.equal(r.args.verbose, undefined);
  });
});

// ─── --chat (REPL mode) ─────────────────────────────────────────────────────

describe("parseRunArgs — --chat", () => {
  it("parses --chat with NO initial prompt (REPL will read all)", () => {
    const r = parseRunArgs(["--chat"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.chat, true);
    assert.equal(r.args.prompt, "");
  });

  it("parses --chat WITH an initial prompt (run once, then REPL)", () => {
    const r = parseRunArgs(["--chat", "--", "fix", "the", "bug"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.chat, true);
    assert.equal(r.args.prompt, "fix the bug");
  });

  it("parses --chat alongside other flags", () => {
    const r = parseRunArgs(["--chat", "--new", "--show-tokens"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.chat, true);
    assert.equal(r.args.newSession, true);
    assert.equal(r.args.showTokens, true);
    assert.equal(r.args.prompt, "");
  });

  it("permits empty prompt without --chat (runCommand decides: stdin? error?)", () => {
    // Parser no longer errors; runCommand decides at runtime based on
    // whether stdin is a TTY. See tests/run-stdin.test.ts for the
    // runtime resolution.
    const r = parseRunArgs([]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "");
    assert.equal(r.args.chat, undefined);
  });

  it("omits chat when not given (one-shot default)", () => {
    const r = parseRunArgs(["--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.chat, undefined);
  });
});

// ─── empty-prompt cases (parser is permissive) ──────────────────────────────

describe("parseRunArgs — empty-prompt cases (parser is permissive)", () => {
  // The parser does not error on empty prompts — runCommand decides
  // at runtime whether to (a) read stdin, (b) drop into chat REPL, or
  // (c) surface "prompt required". The parser stays pure (no isTTY).

  it("accepts empty argv (prompt = '')", () => {
    const r = parseRunArgs([]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "");
  });

  it("accepts flags-only argv with no prompt", () => {
    const r = parseRunArgs(["--new", "--memory"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "");
    assert.equal(r.args.newSession, true);
    assert.equal(r.args.ephemeral, true);
  });

  it("accepts empty prompt after sentinel", () => {
    const r = parseRunArgs(["--new", "--"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "");
  });

  it("treats whitespace-only after sentinel as empty (post-trim)", () => {
    const r = parseRunArgs(["--", "", "  ", ""]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "");
  });
});

// ─── error cases ────────────────────────────────────────────────────────────

describe("parseRunArgs — bare positional → error (the new contract)", () => {
  it("rejects a single bare positional with a `--` hint", () => {
    const r = parseRunArgs(["fix", "the", "bug"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unexpected positional argument: fix/);
    assert.match(r.message, /huko -- fix the bug/);
  });

  it("rejects a bare positional after consumed flags, hint preserves the flags", () => {
    const r = parseRunArgs(["--new", "fix", "the", "bug"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unexpected positional argument: fix/);
    assert.match(r.message, /huko --new -- fix the bug/);
  });

  it("rejects a CJK bare positional (no special-casing for non-ASCII)", () => {
    const r = parseRunArgs(["你是谁？"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unexpected positional/);
    assert.match(r.message, /huko -- 你是谁？/);
  });
});

describe("parseRunArgs — flag-level error cases", () => {

  it("rejects an unknown flag", () => {
    const r = parseRunArgs(["--definitely-not-a-flag", "--", "hi"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unknown flag: --definitely-not-a-flag/);
  });

  it("rejects `-3` as a flag, with a sentinel hint", () => {
    const r = parseRunArgs(["-3", "+", "5"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /unknown flag/);
    assert.match(r.message, /use `--`/);
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

  it("does NOT treat -h after `--` as help (it's prompt content)", () => {
    const r = parseRunArgs(["--", "explain", "-h", "behavior"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.prompt, "explain -h behavior");
  });
});
