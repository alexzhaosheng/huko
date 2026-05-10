/**
 * tests/best-practices.test.ts
 *
 * Section extractor + injection wiring tests.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildBestPracticesInjection,
  extractBestPracticesSection,
} from "../server/task/best-practices.js";
import { loadRole } from "../server/roles/index.js";

// ─── extractBestPracticesSection ────────────────────────────────────────────

describe("extractBestPracticesSection", () => {
  it("returns null when no section is present", () => {
    const body = "# Identity\n\nYou are an agent.\n\n# Tool usage\n\nRead first.";
    assert.equal(extractBestPracticesSection(body), null);
  });

  it("extracts a `## Best Practices` block (case-insensitive)", () => {
    const body = [
      "You are an agent.",
      "",
      "## Best practices",
      "- MUST do this",
      "- MUST NOT do that",
    ].join("\n");
    const got = extractBestPracticesSection(body);
    assert.ok(got);
    assert.match(got!, /MUST do this/);
    assert.match(got!, /MUST NOT do that/);
  });

  it("stops at the next `##` heading", () => {
    const body = [
      "## Best Practices",
      "- bullet one",
      "- bullet two",
      "",
      "## Notes",
      "- this should NOT be included",
    ].join("\n");
    const got = extractBestPracticesSection(body);
    assert.ok(got);
    assert.match(got!, /bullet one/);
    assert.match(got!, /bullet two/);
    assert.doesNotMatch(got!, /should NOT be included/);
  });

  it("handles end-of-body cleanly", () => {
    const body = "## Best Practices\n- only bullet";
    const got = extractBestPracticesSection(body);
    assert.equal(got, "## Best Practices\n- only bullet");
  });
});

// ─── buildBestPracticesInjection ────────────────────────────────────────────

describe("buildBestPracticesInjection", () => {
  it("returns null when capabilities are empty / undefined", async () => {
    assert.equal(await buildBestPracticesInjection(1, "X", undefined), null);
    assert.equal(await buildBestPracticesInjection(1, "X", []), null);
  });

  it("returns null when no capability resolves to a role", async () => {
    const r = await buildBestPracticesInjection(1, "X", ["definitely_not_a_role_xyz123"]);
    assert.equal(r, null);
  });

  it("rejects path-traversal capability names", async () => {
    const r = await buildBestPracticesInjection(1, "X", ["../../../etc/passwd"]);
    assert.equal(r, null);
  });

  it("loads the writing role and includes its Best Practices block", async () => {
    const r = await buildBestPracticesInjection(2, "Draft prose", ["writing"]);
    assert.ok(r, "expected an injection block");
    assert.match(r!, /Phase 2: Draft prose/);
    assert.match(r!, /\[Role: writing\]/);
    assert.match(r!, /Best Practices/);
    assert.match(r!, /MUST.*write_file/);
  });

  it("loads the research role and includes its Best Practices block", async () => {
    const r = await buildBestPracticesInjection(1, "Investigate", ["research"]);
    assert.ok(r);
    assert.match(r!, /\[Role: research\]/);
    assert.match(r!, /multiple/i);
    assert.match(r!, /citation/i);
  });

  it("loads the analysis role and includes its Best Practices block", async () => {
    const r = await buildBestPracticesInjection(1, "Crunch numbers", ["analysis"]);
    assert.ok(r);
    assert.match(r!, /\[Role: analysis\]/);
    assert.match(r!, /pandas/);
    assert.match(r!, /Limitations/);
  });

  it("loads the coding role and includes its Best Practices block", async () => {
    const r = await buildBestPracticesInjection(1, "Patch the bug", ["coding"]);
    assert.ok(r);
    assert.match(r!, /\[Role: coding\]/);
    assert.match(r!, /before patching/i);
  });

  it("combines multiple capabilities into one block", async () => {
    const r = await buildBestPracticesInjection(
      3,
      "Synthesise + write",
      ["research", "writing"],
    );
    assert.ok(r);
    assert.match(r!, /\[Role: research\]/);
    assert.match(r!, /\[Role: writing\]/);
    const idxR = r!.indexOf("[Role: research]");
    const idxW = r!.indexOf("[Role: writing]");
    assert.ok(idxR < idxW, "research should come before writing");
  });

  it("silently skips unknown capabilities mixed with known ones", async () => {
    const r = await buildBestPracticesInjection(
      1,
      "Mixed",
      ["definitely_not_a_role_xyz123", "writing"],
    );
    assert.ok(r);
    assert.match(r!, /\[Role: writing\]/);
    assert.doesNotMatch(r!, /\[Role: definitely_not_a_role/);
  });
});

// ─── role files load cleanly ────────────────────────────────────────────────

describe("builtin role files", () => {
  for (const name of ["general", "coding", "writing", "research", "analysis"]) {
    it(`loads ${name} role with non-empty body`, async () => {
      const role = await loadRole(name);
      assert.ok(role.body.length > 100, `${name} body suspiciously short`);
      assert.match(role.body, /## Best Practices/i);
    });
  }
});
