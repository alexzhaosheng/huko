/**
 * tests/infra-config.test.ts
 *
 * Layered infra config — built-ins, plus optional global and project
 * JSON files. Verifies:
 *   - built-ins are present out of the box
 *   - global file can override and add
 *   - project file overrides global
 *   - disabled* lists drop entries from any lower layer
 *   - default-model precedence (project > global > builtin)
 *   - orphan models (provider absent) are dropped from merged view
 *   - findProvider / findModel lookup helpers
 *   - file errors carry useful messages (path included)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_CURRENT_MODEL,
  BUILTIN_CURRENT_PROVIDER,
  BUILTIN_PROVIDERS,
} from "../server/config/builtin-providers.js";
import {
  findModel,
  findProvider,
  loadInfraConfig,
  writeProjectConfigFile,
} from "../server/config/infra-config.js";
import type { InfraConfigFile } from "../server/config/infra-config-types.js";

let cwd: string;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "huko-infra-cwd-"));
  // Point HOME at a tmp dir so global config is isolated.
  tmpHome = mkdtempSync(join(tmpdir(), "huko-infra-home-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  // os.homedir() honours HOME on POSIX; on Windows it honours USERPROFILE.
  // Tests run on both — set both for safety.
  process.env["USERPROFILE"] = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = savedHome;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeGlobal(file: InfraConfigFile): void {
  mkdirSync(join(tmpHome, ".huko"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".huko", "providers.json"),
    JSON.stringify(file, null, 2),
    "utf8",
  );
}

describe("loadInfraConfig — built-ins only", () => {
  it("returns the curated provider set when no global/project files exist", () => {
    const cfg = loadInfraConfig({ cwd });
    const names = cfg.providers.map((p) => p.name).sort();
    const expected = BUILTIN_PROVIDERS.map((p) => p.name).sort();
    assert.deepEqual(names, expected);
    // Every entry tagged "builtin"
    for (const p of cfg.providers) assert.equal(p.source, "builtin");
  });

  it("current provider + model are the built-in pair", () => {
    const cfg = loadInfraConfig({ cwd });
    assert.ok(cfg.currentProvider);
    assert.equal(cfg.currentProvider!.name, BUILTIN_CURRENT_PROVIDER);
    assert.equal(cfg.currentProviderSource, "builtin");
    assert.ok(cfg.currentModel);
    assert.equal(cfg.currentModel!.providerName, BUILTIN_CURRENT_PROVIDER);
    assert.equal(cfg.currentModel!.modelId, BUILTIN_CURRENT_MODEL);
    assert.equal(cfg.currentModelSource, "builtin");
  });
});

describe("loadInfraConfig — global layer overrides built-in", () => {
  it("override existing provider (same name)", () => {
    writeGlobal({
      providers: [
        {
          name: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://my-corp-proxy.example.com",
          apiKeyRef: "corp_anthropic",
        },
      ],
    });
    const cfg = loadInfraConfig({ cwd });
    const a = findProvider(cfg, "anthropic");
    assert.ok(a);
    assert.equal(a!.baseUrl, "https://my-corp-proxy.example.com");
    assert.equal(a!.apiKeyRef, "corp_anthropic");
    assert.equal(a!.source, "global");
  });

  it("add new provider not in built-ins", () => {
    writeGlobal({
      providers: [
        {
          name: "mistral",
          protocol: "openai",
          baseUrl: "https://api.mistral.ai/v1",
          apiKeyRef: "mistral",
        },
      ],
    });
    const cfg = loadInfraConfig({ cwd });
    const m = findProvider(cfg, "mistral");
    assert.ok(m);
    assert.equal(m!.source, "global");
  });

  it("override current provider + model from global", () => {
    writeGlobal({
      currentProvider: "openrouter",
      currentModel: "openai/gpt-5.5",
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(cfg.currentProvider!.name, "openrouter");
    assert.equal(cfg.currentProviderSource, "global");
    assert.equal(cfg.currentModel!.providerName, "openrouter");
    assert.equal(cfg.currentModel!.modelId, "openai/gpt-5.5");
    assert.equal(cfg.currentModelSource, "global");
  });
});

describe("loadInfraConfig — project layer overrides global", () => {
  it("project provider beats global override", () => {
    writeGlobal({
      providers: [
        {
          name: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://global-override.example.com",
          apiKeyRef: "g",
        },
      ],
    });
    writeProjectConfigFile(cwd, {
      providers: [
        {
          name: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://project-override.example.com",
          apiKeyRef: "p",
        },
      ],
    });
    const cfg = loadInfraConfig({ cwd });
    const a = findProvider(cfg, "anthropic")!;
    assert.equal(a.baseUrl, "https://project-override.example.com");
    assert.equal(a.source, "project");
  });

  it("project current pointers beat global", () => {
    writeGlobal({
      currentProvider: "anthropic",
      currentModel: "claude-opus-4-6",
    });
    writeProjectConfigFile(cwd, {
      currentProvider: "deepseek",
      currentModel: "deepseek-v4-pro",
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(cfg.currentProvider!.name, "deepseek");
    assert.equal(cfg.currentProviderSource, "project");
    assert.equal(cfg.currentModel!.modelId, "deepseek-v4-pro");
    assert.equal(cfg.currentModelSource, "project");
  });

  it("layers can split — project sets provider only, global sets model only", () => {
    writeGlobal({
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4-6",
    });
    writeProjectConfigFile(cwd, {
      // project only overrides the provider; model still comes from global
      currentProvider: "openrouter",
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(cfg.currentProviderSource, "project");
    assert.equal(cfg.currentProvider!.name, "openrouter");
    assert.equal(cfg.currentModelSource, "global");
    // The pair (openrouter, claude-sonnet-4-6) is invalid — no such
    // model. Resolved currentModel is null but the source is preserved.
    assert.equal(cfg.currentModel, null);
  });
});

describe("loadInfraConfig — disabled lists", () => {
  it("global can disable a built-in provider", () => {
    writeGlobal({
      disabledProviders: ["ollama"],
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(findProvider(cfg, "ollama"), null);
    // Unrelated built-ins still present
    assert.ok(findProvider(cfg, "anthropic"));
  });

  it("project can disable a built-in model", () => {
    writeProjectConfigFile(cwd, {
      disabledModels: [
        { providerName: "anthropic", modelId: "claude-opus-4-6" },
      ],
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(findModel(cfg, "anthropic", "claude-opus-4-6"), null);
    // Sibling models survive
    assert.ok(findModel(cfg, "anthropic", "claude-sonnet-4-6"));
  });

  it("disabling a provider drops its models from merged view (orphaned)", () => {
    writeGlobal({
      disabledProviders: ["deepseek"],
    });
    const cfg = loadInfraConfig({ cwd });
    assert.equal(findProvider(cfg, "deepseek"), null);
    assert.equal(findModel(cfg, "deepseek", "deepseek-v4-pro"), null);
    assert.equal(findModel(cfg, "deepseek", "deepseek-v4-flash"), null);
  });
});

describe("loadInfraConfig — error handling", () => {
  it("missing files are equivalent to empty config (no throw)", () => {
    // Both global and project files absent — only built-ins should appear.
    const cfg = loadInfraConfig({ cwd });
    assert.ok(cfg.providers.length > 0);
  });

  it("malformed JSON throws with the file path in the message", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(join(cwd, ".huko", "providers.json"), "{not valid json", "utf8");
    assert.throws(
      () => loadInfraConfig({ cwd }),
      (err: Error) =>
        /providers\.json/.test(err.message) && /not valid JSON/.test(err.message),
    );
  });

  it("non-object JSON throws", () => {
    mkdirSync(join(cwd, ".huko"), { recursive: true });
    writeFileSync(join(cwd, ".huko", "providers.json"), "[1,2,3]", "utf8");
    assert.throws(
      () => loadInfraConfig({ cwd }),
      /JSON object at top level/,
    );
  });
});

describe("findProvider / findModel", () => {
  it("returns null for unknown name", () => {
    const cfg = loadInfraConfig({ cwd });
    assert.equal(findProvider(cfg, "nope"), null);
    assert.equal(findModel(cfg, "anthropic", "no-such-model"), null);
  });

  it("found model carries its resolved provider", () => {
    const cfg = loadInfraConfig({ cwd });
    const m = findModel(cfg, "anthropic", "claude-sonnet-4-6");
    assert.ok(m);
    assert.equal(m!.provider.name, "anthropic");
    assert.equal(m!.provider.protocol, "anthropic");
  });
});
