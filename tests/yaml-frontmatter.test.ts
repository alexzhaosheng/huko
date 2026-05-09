/**
 * tests/yaml-frontmatter.test.ts
 *
 * The minimal YAML subset parser used for role frontmatter. We don't
 * need full YAML — just scalars, inline arrays, two-level nesting,
 * comments. A handful of edge cases bit us in development (`#` mid-
 * token used to truncate values); they're each pinned here.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseYamlSubset } from "../server/roles/yaml-frontmatter.js";

describe("parseYamlSubset", () => {
  it("parses scalars: string / number / boolean / null", () => {
    const r = parseYamlSubset(
      `name: openrouter
n: 42
flag: true
flag2: false
empty: null
tilde: ~`,
    );
    assert.deepEqual(r, {
      name: "openrouter",
      n: 42,
      flag: true,
      flag2: false,
      empty: null,
      tilde: null,
    });
  });

  it("parses quoted strings (preserves colons and spaces)", () => {
    const r = parseYamlSubset(
      `a: "hello: world"
b: 'single: quoted'`,
    );
    assert.deepEqual(r, { a: "hello: world", b: "single: quoted" });
  });

  it("parses inline arrays", () => {
    const r = parseYamlSubset(
      `tools: [shell, file, message]
nums: [1, 2, 3]
empty: []`,
    );
    assert.deepEqual(r, {
      tools: ["shell", "file", "message"],
      nums: [1, 2, 3],
      empty: [],
    });
  });

  it("parses two-level nested objects", () => {
    const r = parseYamlSubset(
      `tools:
  allow: [a, b]
  deny: [c]
description: hi`,
    );
    assert.deepEqual(r, {
      tools: { allow: ["a", "b"], deny: ["c"] },
      description: "hi",
    });
  });

  it("strips trailing comments after whitespace", () => {
    const r = parseYamlSubset(`name: openrouter  # this is a comment`);
    assert.deepEqual(r, { name: "openrouter" });
  });

  it("does NOT treat # mid-token as a comment", () => {
    // Regression: an early version stripped at any `#`, breaking refs
    // like `a#b`. Comment must be preceded by whitespace.
    const r = parseYamlSubset(`ref: a#b`);
    assert.deepEqual(r, { ref: "a#b" });
  });

  it("ignores full-line comments and blank lines", () => {
    const r = parseYamlSubset(
      `# top comment
name: x

# middle comment
n: 1`,
    );
    assert.deepEqual(r, { name: "x", n: 1 });
  });

  it("rejects 3+ levels of nesting", () => {
    assert.throws(
      () =>
        parseYamlSubset(
          `a:
  b:
    c: 1`,
        ),
      /3\+ levels/,
    );
  });

  it("rejects unexpected indent at top level", () => {
    assert.throws(() => parseYamlSubset(`  name: x`), /unexpected indent/);
  });

  it("rejects malformed key lines", () => {
    assert.throws(() => parseYamlSubset(`not a key value`), /cannot parse/);
  });
});
