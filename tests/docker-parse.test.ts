/**
 * tests/docker-parse.test.ts
 *
 * Unit tests for `huko docker run`'s argv parsing + the pure helpers in
 * commands/docker.ts. We don't spawn an actual `docker` here — the
 * spawn path is plumbing (stdio:"inherit" + exit-code forwarding) and
 * doesn't have interesting branches worth integration-testing without
 * a real daemon.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";

import { parseDockerRun } from "../server/cli/dispatch/docker.js";
import {
  _buildDockerArgsForTest,
  _collectKeyEnvVarsForTest,
  _resolveImageForTest,
} from "../server/cli/commands/docker.js";

// ─── parseDockerRun ─────────────────────────────────────────────────────────

describe("parseDockerRun — happy path", () => {
  it("bare: no args produces empty innerArgv + no image override", () => {
    const r = parseDockerRun([]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, undefined);
    assert.deepEqual(r.args.innerArgv, []);
  });

  it("passes through `--` and the prompt verbatim", () => {
    const r = parseDockerRun(["--", "fix", "the", "bug"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, undefined);
    assert.deepEqual(r.args.innerArgv, ["--", "fix", "the", "bug"]);
  });

  it("forwards huko-style flags untouched", () => {
    const r = parseDockerRun(["--lean", "--memory", "--", "what's up"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.deepEqual(r.args.innerArgv, ["--lean", "--memory", "--", "what's up"]);
  });

  it("forwards huko subcommand argv (e.g. `huko docker run sessions list`)", () => {
    const r = parseDockerRun(["sessions", "list"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.deepEqual(r.args.innerArgv, ["sessions", "list"]);
  });
});

describe("parseDockerRun — --image (split form)", () => {
  it("consumes `--image foo` and forwards the rest", () => {
    const r = parseDockerRun(["--image", "myorg/huko:dev", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, "myorg/huko:dev");
    assert.deepEqual(r.args.innerArgv, ["--", "hi"]);
  });

  it("errors when `--image` has no value", () => {
    const r = parseDockerRun(["--image"]);
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.match(r.message, /--image requires a value/);
  });

  it("permits `--image` interleaved with huko flags (only the first wrapper-flag run is parsed)", () => {
    // After `--image foo` we keep parsing wrapper flags; once we hit
    // `--lean` (not a wrapper flag) we hand off the remainder.
    const r = parseDockerRun(["--image", "x", "--lean", "--", "go"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, "x");
    assert.deepEqual(r.args.innerArgv, ["--lean", "--", "go"]);
  });
});

describe("parseDockerRun — --image=value (glued form)", () => {
  it("consumes `--image=myorg/huko:1`", () => {
    const r = parseDockerRun(["--image=myorg/huko:1", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, "myorg/huko:1");
    assert.deepEqual(r.args.innerArgv, ["--", "hi"]);
  });

  it("supports an empty value (defensive — wrapper still records it as such)", () => {
    const r = parseDockerRun(["--image=", "--", "hi"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, "");
    // resolveImage will treat empty string as "fall through to env / default"
  });
});

describe("parseDockerRun — `--` boundary", () => {
  it("after `--`, `--image` is part of the prompt, not the wrapper flag", () => {
    const r = parseDockerRun(["--", "--image", "is", "literal"]);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.args.image, undefined);
    assert.deepEqual(r.args.innerArgv, ["--", "--image", "is", "literal"]);
  });
});

describe("parseDockerRun — help short-circuit", () => {
  it("returns help for -h", () => {
    const r = parseDockerRun(["-h"]);
    assert.equal(r.kind, "help");
  });
  it("returns help for --help", () => {
    const r = parseDockerRun(["--help"]);
    assert.equal(r.kind, "help");
  });
});

// ─── _resolveImageForTest ───────────────────────────────────────────────────

describe("resolveImage precedence", () => {
  // Mirrors DEFAULT_IMAGE in commands/docker.ts. Stable channel.
  const DEFAULT = "ghcr.io/alexzhaosheng/huko:latest";

  it("explicit wins over env wins over default", () => {
    assert.equal(
      _resolveImageForTest("explicit/img:1", { HUKO_DOCKER_IMAGE: "env/img:2" }),
      "explicit/img:1",
    );
    assert.equal(
      _resolveImageForTest(undefined, { HUKO_DOCKER_IMAGE: "env/img:2" }),
      "env/img:2",
    );
    assert.equal(_resolveImageForTest(undefined, {}), DEFAULT);
  });

  it("empty explicit falls through to env", () => {
    assert.equal(
      _resolveImageForTest("", { HUKO_DOCKER_IMAGE: "env/img:2" }),
      "env/img:2",
    );
  });

  it("empty env falls through to default", () => {
    assert.equal(_resolveImageForTest(undefined, { HUKO_DOCKER_IMAGE: "" }), DEFAULT);
  });
});

// ─── _buildDockerArgsForTest ───────────────────────────────────────────────

describe("buildDockerArgs", () => {
  const baseOpts = { cwd: "/host/proj", home: "/host/home", isTTY: false };

  it("produces the canonical argv with -i (no TTY)", () => {
    const args = _buildDockerArgsForTest("img:1", ["--", "hello"], baseOpts);
    // The home-mount path goes through `path.join`, which on Windows
    // emits backslashes (`\host\home\.huko`) — that's correct, Docker
    // Desktop on Windows accepts native paths in `-v`. Mirror the same
    // platform-specific join in the expected so the assertion holds on
    // POSIX and Windows alike. The cwd-mount uses the raw string in
    // production code, so its expected stays a literal.
    assert.deepEqual(args, [
      "run",
      "--rm",
      "-i",
      "-v", "/host/proj:/work",
      "-v", `${path.join("/host/home", ".huko")}:/root/.huko`,
      "--workdir", "/work",
      "img:1",
      "--", "hello",
    ]);
  });

  it("uses -it when stdin is a TTY", () => {
    const args = _buildDockerArgsForTest("img:1", [], { ...baseOpts, isTTY: true });
    assert.equal(args[2], "-it");
  });

  it("appends innerArgv verbatim (no escaping / reordering)", () => {
    const inner = ["--lean", "--", "what's", "up", "with", "--this"];
    const args = _buildDockerArgsForTest("img:1", inner, baseOpts);
    const after = args.slice(args.indexOf("img:1") + 1);
    assert.deepEqual(after, inner);
  });

  it("inserts -e <NAME> for each forwarded env var, before the mounts", () => {
    const args = _buildDockerArgsForTest("img:1", ["--", "go"], {
      ...baseOpts,
      forwardedEnvVars: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"],
    });
    // -e flags appear after the interactive flag and before the -v mounts,
    // each as TWO argv entries (no value on -e).
    const interactiveIdx = args.indexOf("-i");
    const firstMountIdx = args.indexOf("-v");
    const between = args.slice(interactiveIdx + 1, firstMountIdx);
    assert.deepEqual(between, ["-e", "DEEPSEEK_API_KEY", "-e", "OPENROUTER_API_KEY"]);
  });

  it("inserts no -e flags when forwardedEnvVars is empty / omitted", () => {
    const a = _buildDockerArgsForTest("img:1", [], { ...baseOpts, forwardedEnvVars: [] });
    const b = _buildDockerArgsForTest("img:1", [], baseOpts); // omitted
    assert.equal(a.includes("-e"), false);
    assert.equal(b.includes("-e"), false);
  });
});

describe("_collectKeyEnvVarsForTest", () => {
  it("derives <REF>_API_KEY from each ref + filters to set+non-empty in env", () => {
    const refs = ["deepseek", "openrouter", "anthropic"];
    const env = {
      DEEPSEEK_API_KEY: "sk-deepseek-xxx",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      OTHER_VAR: "irrelevant",
    };
    const result = _collectKeyEnvVarsForTest(refs, env);
    // openrouter not in env → not forwarded; anthropic + deepseek included
    assert.deepEqual(result.sort(), ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"].sort());
  });

  it("dedupes when multiple providers share the same ref", () => {
    const refs = ["openrouter", "openrouter"];
    const env = { OPENROUTER_API_KEY: "sk-or-xxx" };
    const result = _collectKeyEnvVarsForTest(refs, env);
    assert.deepEqual(result, ["OPENROUTER_API_KEY"]);
  });

  it("treats empty string as unset (filtered out)", () => {
    const refs = ["foo"];
    const env = { FOO_API_KEY: "" };
    const result = _collectKeyEnvVarsForTest(refs, env);
    assert.deepEqual(result, []);
  });

  it("normalises non-alphanum chars in refs (matches envVarNameFor convention)", () => {
    const refs = ["my-corp.gateway"];
    const env = { MY_CORP_GATEWAY_API_KEY: "sk-xxx" };
    const result = _collectKeyEnvVarsForTest(refs, env);
    assert.deepEqual(result, ["MY_CORP_GATEWAY_API_KEY"]);
  });

  it("returns empty when refs is empty", () => {
    assert.deepEqual(_collectKeyEnvVarsForTest([], { DEEPSEEK_API_KEY: "x" }), []);
  });
});
