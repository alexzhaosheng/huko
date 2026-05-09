/**
 * tests/keys.test.ts
 *
 * The three-layer API-key resolution + the project-keys.json
 * read/write helpers. These are security-adjacent — wrong precedence
 * could leak the wrong key, and `describeKeySource` MUST never return
 * the actual value.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeKeySource,
  envVarNameFor,
  listProjectKeyRefs,
  resolveApiKey,
  setProjectKey,
  unsetProjectKey,
} from "../server/security/keys.js";

let cwd: string;
const TEST_REF = "test_provider";
const TEST_ENV_NAME = "TEST_PROVIDER_API_KEY";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-keys-test-"));
  delete process.env[TEST_ENV_NAME];
});

afterEach(() => {
  delete process.env[TEST_ENV_NAME];
  rmSync(cwd, { recursive: true, force: true });
});

describe("envVarNameFor", () => {
  it("uppercases and appends _API_KEY", () => {
    assert.equal(envVarNameFor("openrouter"), "OPENROUTER_API_KEY");
    assert.equal(envVarNameFor("anthropic"), "ANTHROPIC_API_KEY");
  });

  it("replaces non-alphanumeric chars with _", () => {
    assert.equal(envVarNameFor("my-corp.gateway"), "MY_CORP_GATEWAY_API_KEY");
    assert.equal(envVarNameFor("a b c"), "A_B_C_API_KEY");
  });
});

describe("resolveApiKey priority", () => {
  it("layer 1 wins: project keys.json over env over .env", () => {
    setProjectKey(TEST_REF, "from-keys-json", { cwd });
    process.env[TEST_ENV_NAME] = "from-env";
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=from-dotenv\n`);

    assert.equal(resolveApiKey(TEST_REF, { cwd }), "from-keys-json");
  });

  it("layer 2 wins when keys.json absent: env over .env", () => {
    process.env[TEST_ENV_NAME] = "from-env";
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=from-dotenv\n`);

    assert.equal(resolveApiKey(TEST_REF, { cwd }), "from-env");
  });

  it("layer 3 wins when both above absent: .env", () => {
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=from-dotenv\n`);
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "from-dotenv");
  });

  it("throws when no layer has a value", () => {
    assert.throws(() => resolveApiKey(TEST_REF, { cwd }), /No API key found/);
  });

  it("throws on empty ref", () => {
    assert.throws(() => resolveApiKey("", { cwd }), /empty ref/);
    assert.throws(() => resolveApiKey("   ", { cwd }), /empty ref/);
  });

  it("ignores empty-string values (treats as absent)", () => {
    setProjectKey(TEST_REF, "x", { cwd }); // create keys.json file
    // Manually overwrite to set an empty-string
    writeFileSync(
      join(cwd, ".huko", "keys.json"),
      JSON.stringify({ [TEST_REF]: "" }),
    );
    process.env[TEST_ENV_NAME] = "from-env";

    assert.equal(resolveApiKey(TEST_REF, { cwd }), "from-env");
  });
});

describe("describeKeySource", () => {
  it("reports the active layer without leaking the value", () => {
    setProjectKey(TEST_REF, "secret-12345", { cwd });
    const desc = describeKeySource(TEST_REF, { cwd });
    assert.deepEqual(desc, { layer: "project", envName: TEST_ENV_NAME });
    assert.ok(!JSON.stringify(desc).includes("secret-12345"));
  });

  it("reports unset when no layer has the ref", () => {
    assert.deepEqual(describeKeySource(TEST_REF, { cwd }), {
      layer: "unset",
      envName: TEST_ENV_NAME,
    });
  });

  it("reports env layer", () => {
    process.env[TEST_ENV_NAME] = "x";
    assert.equal(describeKeySource(TEST_REF, { cwd }).layer, "env");
  });

  it("reports dotenv layer", () => {
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=x\n`);
    assert.equal(describeKeySource(TEST_REF, { cwd }).layer, "dotenv");
  });
});

describe("setProjectKey / unsetProjectKey / listProjectKeyRefs", () => {
  it("set then list returns the ref name only", () => {
    setProjectKey(TEST_REF, "secret-12345", { cwd });
    const refs = listProjectKeyRefs({ cwd });
    assert.deepEqual(refs, [TEST_REF]);
  });

  it("set merges with existing keys.json contents", () => {
    setProjectKey("a", "x", { cwd });
    setProjectKey("b", "y", { cwd });
    const refs = listProjectKeyRefs({ cwd }).sort();
    assert.deepEqual(refs, ["a", "b"]);
  });

  it("rejects empty ref or empty value", () => {
    assert.throws(() => setProjectKey("", "x", { cwd }));
    assert.throws(() => setProjectKey("a", "", { cwd }));
  });

  it("unset returns false when ref absent", () => {
    assert.equal(unsetProjectKey("not-there", { cwd }), false);
  });

  it("unset returns true and removes the ref", () => {
    setProjectKey("a", "x", { cwd });
    assert.equal(unsetProjectKey("a", { cwd }), true);
    assert.deepEqual(listProjectKeyRefs({ cwd }), []);
  });

  it("unset preserves siblings", () => {
    setProjectKey("a", "x", { cwd });
    setProjectKey("b", "y", { cwd });
    unsetProjectKey("a", { cwd });
    assert.deepEqual(listProjectKeyRefs({ cwd }), ["b"]);
  });
});

describe(".env parser tolerance", () => {
  it("parses bare KEY=value", () => {
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=plain\n`);
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "plain");
  });

  it("parses double-quoted values with internal spaces", () => {
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}="with spaces"\n`);
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "with spaces");
  });

  it("strips trailing inline comment from bare values", () => {
    writeFileSync(join(cwd, ".env"), `${TEST_ENV_NAME}=plain # comment here\n`);
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "plain");
  });

  it("tolerates `export` prefix", () => {
    writeFileSync(join(cwd, ".env"), `export ${TEST_ENV_NAME}=exported\n`);
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "exported");
  });

  it("ignores comment-only lines", () => {
    writeFileSync(
      join(cwd, ".env"),
      `# top comment\n${TEST_ENV_NAME}=x\n# bottom comment\n`,
    );
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "x");
  });

  it("malformed .env lines are skipped, not thrown", () => {
    writeFileSync(
      join(cwd, ".env"),
      `not-a-key-line\n${TEST_ENV_NAME}=ok\nanother-bad-line\n`,
    );
    assert.equal(resolveApiKey(TEST_REF, { cwd }), "ok");
  });
});

describe("keys.json security: never read non-string values as keys", () => {
  it("ignores non-string values in keys.json", () => {
    setProjectKey("seed", "x", { cwd }); // create the .huko directory
    writeFileSync(
      join(cwd, ".huko", "keys.json"),
      JSON.stringify({ [TEST_REF]: 42, valid: "ok" }),
    );
    assert.deepEqual(listProjectKeyRefs({ cwd }), ["valid"]);
    assert.throws(() => resolveApiKey(TEST_REF, { cwd }));
  });

  it("ignores malformed JSON in keys.json", () => {
    setProjectKey("seed", "x", { cwd });
    writeFileSync(join(cwd, ".huko", "keys.json"), "not valid json {{{");
    assert.deepEqual(listProjectKeyRefs({ cwd }), []);
    assert.throws(() => resolveApiKey(TEST_REF, { cwd }));
  });
});
