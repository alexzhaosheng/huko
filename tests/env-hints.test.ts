/**
 * tests/env-hints.test.ts
 *
 * Pure unit tests for `isLikelyPowerShell` + `formatPowerShellSentinelHint`.
 * Both are environment hints attached to error paths only — never affect
 * control flow.
 *
 * The PowerShell detection takes an explicit env arg, so we don't have
 * to mutate `process.env` in tests.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  isLikelyPowerShell,
  formatPowerShellSentinelHint,
} from "../server/cli/env-hints.js";

// ─── isLikelyPowerShell ─────────────────────────────────────────────────────

describe("isLikelyPowerShell", () => {
  it("returns true when PSModulePath is set (typical PowerShell)", () => {
    const env = {
      PSModulePath: "C:\\Users\\u\\Documents\\PowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
    };
    assert.equal(isLikelyPowerShell(env), true);
  });

  it("returns true for pwsh on non-Windows (PSModulePath still set)", () => {
    const env = { PSModulePath: "/usr/local/share/powershell/Modules" };
    assert.equal(isLikelyPowerShell(env), true);
  });

  it("returns false when PSModulePath is absent", () => {
    const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
    assert.equal(isLikelyPowerShell(env), false);
  });

  it("returns false when PSModulePath is empty string", () => {
    const env = { PSModulePath: "" };
    assert.equal(isLikelyPowerShell(env), false);
  });

  it("returns false when PSModulePath is undefined", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(isLikelyPowerShell(env), false);
  });

  it("uses process.env by default when no arg passed", () => {
    // Just make sure it doesn't throw — actual value depends on the
    // test runner's environment, which we don't want to assert on.
    const result = isLikelyPowerShell();
    assert.equal(typeof result, "boolean");
  });
});

// ─── formatPowerShellSentinelHint ──────────────────────────────────────────

describe("formatPowerShellSentinelHint", () => {
  it("mentions PowerShell explicitly", () => {
    const out = formatPowerShellSentinelHint();
    assert.match(out, /PowerShell/);
  });

  it("describes the `--` stripping symptom", () => {
    const out = formatPowerShellSentinelHint();
    // The string should reference `--` and the fact it gets dropped.
    assert.ok(out.includes("`--`"), "should reference the `--` token");
    assert.match(out, /dropped|strip|consum/i);
  });

  it("lists all three labeled workarounds (a), (b), (c)", () => {
    const out = formatPowerShellSentinelHint();
    assert.match(out, /\(a\)/);
    assert.match(out, /\(b\)/);
    assert.match(out, /\(c\)/);
  });

  it("workaround (a) shows the quoted-sentinel form", () => {
    const out = formatPowerShellSentinelHint();
    assert.match(out, /\(a\)[\s\S]*"--"/);
  });

  it("workaround (b) shows the PSNativeCommandArgumentPassing variable", () => {
    const out = formatPowerShellSentinelHint();
    assert.match(out, /\(b\)[\s\S]*PSNativeCommandArgumentPassing/);
    assert.match(out, /'Standard'/);
  });

  it("workaround (c) shows the --% stop-parsing form", () => {
    const out = formatPowerShellSentinelHint();
    assert.match(out, /\(c\)[\s\S]*--%/);
  });

  it("ends with a trailing newline so callers can concat safely", () => {
    const out = formatPowerShellSentinelHint();
    assert.equal(out.endsWith("\n"), true);
  });

  it("starts with a blank line for visual separation from preceding text", () => {
    const out = formatPowerShellSentinelHint();
    assert.equal(out.startsWith("\n"), true);
  });
});
