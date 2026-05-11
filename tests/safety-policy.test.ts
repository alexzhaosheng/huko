/**
 * tests/safety-policy.test.ts
 *
 * Pure unit tests for `evaluatePolicy` — the safety decision engine.
 * No I/O, no fixtures, just a config object + a tool call.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  evaluatePolicy,
  matchPattern,
  extractMatchableValues,
  validateRules,
} from "../server/safety/policy.js";
import type { HukoConfig } from "../server/config/types.js";

const NEUTRAL_DEFAULTS: HukoConfig["safety"] = {
  byDangerLevel: { safe: "auto", moderate: "auto", dangerous: "auto" },
  toolRules: {},
};

function withRules(rules: HukoConfig["safety"]["toolRules"]): HukoConfig["safety"] {
  return { ...NEUTRAL_DEFAULTS, toolRules: rules };
}

// ─── matchPattern ──────────────────────────────────────────────────────────

describe("matchPattern", () => {
  it("does case-sensitive literal-prefix match by default", () => {
    assert.equal(matchPattern("rm -rf /", "rm"), true);
    assert.equal(matchPattern("rm -rf /", "rm -rf"), true);
    assert.equal(matchPattern("ls -la", "rm"), false);
    assert.equal(matchPattern("RM file", "rm"), false);
  });

  it("treats `re:` prefix as ECMAScript regex (anywhere via .test)", () => {
    assert.equal(matchPattern("sudo apt install", "re:^sudo\\b"), true);
    assert.equal(matchPattern("not-sudo", "re:^sudo\\b"), false);
    assert.equal(matchPattern("foo--force-bar", "re:--force"), true);
  });

  it("returns false (not throw) on malformed regex", () => {
    assert.equal(matchPattern("anything", "re:^(unclosed"), false);
  });

  it("literal prefix is NOT a substring match", () => {
    assert.equal(matchPattern("git push origin main", "push"), false);
    assert.equal(matchPattern("push --force", "push"), true);
  });
});

// ─── extractMatchableValues ────────────────────────────────────────────────

describe("extractMatchableValues", () => {
  it("pulls only the fields declared for the tool", () => {
    const out = extractMatchableValues("bash", {
      command: "ls",
      input: "y\n",
      session: "default",
      cwd: "/tmp",
    });
    assert.deepEqual(out.map((x) => x.field).sort(), ["command", "input"]);
  });

  it("skips non-string and empty values", () => {
    const out = extractMatchableValues("bash", { command: "", input: 42 as unknown as string });
    assert.equal(out.length, 0);
  });

  it("returns [] for tools with no declared match fields", () => {
    const out = extractMatchableValues("plan", { goal: "x" });
    assert.deepEqual(out, []);
  });

  it("handles multi-field tools (move_file: from + to)", () => {
    const out = extractMatchableValues("move_file", { from: "/a", to: "/b" });
    assert.deepEqual(
      out.sort((a, b) => a.field.localeCompare(b.field)),
      [
        { field: "from", value: "/a" },
        { field: "to", value: "/b" },
      ],
    );
  });
});

// ─── evaluatePolicy: byDangerLevel fallback ────────────────────────────────

describe("evaluatePolicy — byDangerLevel fallback", () => {
  it("returns auto when level policy is auto and no rules match", () => {
    const decision = evaluatePolicy({
      toolName: "write_file",
      args: { path: "/tmp/x" },
      dangerLevel: "moderate",
      safety: NEUTRAL_DEFAULTS,
    });
    assert.equal(decision.action, "auto");
    assert.equal(decision.source, "default");
  });

  it("returns prompt when level policy is prompt and no rules", () => {
    const safety: HukoConfig["safety"] = {
      ...NEUTRAL_DEFAULTS,
      byDangerLevel: { safe: "auto", moderate: "auto", dangerous: "prompt" },
    };
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "ls" },
      dangerLevel: "dangerous",
      safety,
    });
    assert.equal(decision.action, "prompt");
    assert.equal(decision.source, "default");
  });

  it("returns deny when level policy is deny", () => {
    const safety: HukoConfig["safety"] = {
      ...NEUTRAL_DEFAULTS,
      byDangerLevel: { safe: "auto", moderate: "deny", dangerous: "deny" },
    };
    const decision = evaluatePolicy({
      toolName: "write_file",
      args: { path: "/tmp/x" },
      dangerLevel: "moderate",
      safety,
    });
    assert.equal(decision.action, "deny");
    assert.equal(decision.source, "default");
  });
});

// ─── evaluatePolicy: per-tool rules precedence ─────────────────────────────

describe("evaluatePolicy — per-tool rule precedence", () => {
  it("deny rule wins over byDangerLevel auto", () => {
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "sudo apt install foo" },
      dangerLevel: "dangerous",
      safety: withRules({ bash: { deny: ["sudo"] } }),
    });
    assert.equal(decision.action, "deny");
    assert.equal(decision.source, "rule");
    assert.equal(decision.matchedPattern, "sudo");
    assert.equal(decision.matchedField, "command");
  });

  it("deny rule wins over allow rule (deny > allow)", () => {
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "sudo apt install foo" },
      dangerLevel: "dangerous",
      safety: withRules({
        bash: { allow: ["sudo"], deny: ["sudo"] },
      }),
    });
    assert.equal(decision.action, "deny");
  });

  it("allow rule bypasses requireConfirm AND byDangerLevel prompt", () => {
    const safety: HukoConfig["safety"] = {
      byDangerLevel: { safe: "auto", moderate: "auto", dangerous: "prompt" },
      toolRules: {
        bash: { allow: ["npm install"], requireConfirm: ["npm install"] },
      },
    };
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "npm install lodash" },
      dangerLevel: "dangerous",
      safety,
    });
    assert.equal(decision.action, "auto");
    assert.equal(decision.source, "rule");
  });

  it("requireConfirm rule turns auto into prompt", () => {
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "git push --force origin main" },
      dangerLevel: "dangerous",
      safety: withRules({ bash: { requireConfirm: ["re:--force"] } }),
    });
    assert.equal(decision.action, "prompt");
    assert.equal(decision.matchedPattern, "re:--force");
  });

  it("returns auto when no rule matches and byDangerLevel is auto", () => {
    const decision = evaluatePolicy({
      toolName: "bash",
      args: { command: "ls -la" },
      dangerLevel: "dangerous",
      safety: withRules({
        bash: { deny: ["sudo"], requireConfirm: ["re:--force"] },
      }),
    });
    assert.equal(decision.action, "auto");
  });

  it("matches across multiple fields (move_file: from + to)", () => {
    const safety = withRules({ move_file: { deny: ["/etc/"] } });
    const decision = evaluatePolicy({
      toolName: "move_file",
      args: { from: "/tmp/x", to: "/etc/passwd" },
      dangerLevel: "moderate",
      safety,
    });
    assert.equal(decision.action, "deny");
    assert.equal(decision.matchedField, "to");
  });
});

// ─── validateRules ─────────────────────────────────────────────────────────

describe("validateRules", () => {
  it("reports broken regex patterns", () => {
    const issues = validateRules({
      bash: {
        deny: ["sudo", "re:^([broken"],
        requireConfirm: ["re:--force"],
      },
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.bucket, "deny");
    assert.equal(issues[0]!.index, 1);
    assert.match(issues[0]!.pattern, /broken/);
  });

  it("returns [] when all patterns are valid", () => {
    const issues = validateRules({
      bash: { deny: ["sudo", "re:^rm\\s+-rf"], allow: ["ls"] },
    });
    assert.deepEqual(issues, []);
  });
});
