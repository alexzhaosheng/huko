/**
 * server/cli/commands/setup.ts
 *
 * `huko setup` — interactive wizard for the "I just installed huko"
 * happy path.
 *
 * Flow:
 *   1. Pick scope: global (~/.huko/) or project (<cwd>/.huko/)
 *   2. Pick provider: from BUILTIN_PROVIDERS, plus a "custom" option
 *   3. Confirm or customise the apiKeyRef
 *   4. Choose key handling:
 *        a) enter the key now → save to keys.json (chmod 600)
 *        b) skip — set ANTHROPIC_API_KEY=... in env / .env yourself
 *   5. Pick a default model: from BUILTIN_MODELS for that provider,
 *      plus "enter custom model id"
 *   6. Write everything atomically (providers.json + optional keys.json)
 *      and print a summary + "try it" hint
 *
 * Each step is overrideable via existing config — the wizard merely
 * writes layers; loadInfraConfig() does the merging at runtime.
 *
 * Exit codes:
 *   0 ok    1 internal error    130 user cancelled (Ctrl+C / Ctrl+D)
 */

import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDERS,
  loadInfraConfig,
  readGlobalConfigFile,
  readProjectConfigFile,
  writeGlobalConfigFile,
  writeProjectConfigFile,
  type InfraConfigFile,
  type ModelConfig,
  type ProviderConfig,
} from "../../config/index.js";
import {
  envVarNameFor,
  globalKeysPath,
  projectKeysPath,
  setGlobalKey,
  setProjectKey,
} from "../../security/keys.js";
import {
  PromptCancelled,
  openPrompter,
  type Prompter,
  type SelectItem,
} from "./prompts.js";
import { bold, cyan, dim, green, yellow } from "../colors.js";

type Scope = "global" | "project";
type KeyMode = "store" | "skip";

export async function setupCommand(): Promise<number> {
  process.stderr.write(
    "\n" + bold("huko setup", "stderr") + " — configure a provider, a key, and a default model.\n" +
      dim("Press Ctrl+C any time to abort.", "stderr") + "\n\n",
  );

  const p = openPrompter();
  try {
    const cwd = process.cwd();

    // ── Step 1: scope ────────────────────────────────────────────────────
    const scope = await pickScope(p);

    // ── Step 2: provider ─────────────────────────────────────────────────
    const provider = await pickProvider(p);

    // ── Step 3: how does the user want to provide the key? ───────────────
    // Ref name only matters in env-var mode (it determines the env var
    // name). For direct entry, the ref is an internal identifier in
    // keys.json — defaulting to provider.name keeps things simple.
    const keyMode = await pickKeyMode(p, provider.name);

    let apiKeyRef: string;
    if (keyMode === "store") {
      apiKeyRef = provider.name;
      persistProvider(scope, cwd, { ...provider, apiKeyRef });
      const value = await p.promptHidden(`Enter ${apiKeyRef} API key (input hidden)`);
      if (!value) {
        process.stderr.write("huko: empty key, aborting key save (provider entry kept)\n");
      } else {
        if (scope === "global") setGlobalKey(apiKeyRef, value);
        else setProjectKey(apiKeyRef, value, { cwd });
        const dest = scope === "global" ? globalKeysPath() : projectKeysPath(cwd);
        process.stderr.write(green(`huko: wrote key "${apiKeyRef}" to ${dest} (chmod 600)`, "stderr") + "\n");
      }
    } else {
      // env-var mode — let the user customize the ref so it maps to the
      // env var name they actually want (e.g. work vs personal splits).
      apiKeyRef = await pickKeyRef(p, provider);
      persistProvider(scope, cwd, { ...provider, apiKeyRef });
      const envName = envVarNameFor(apiKeyRef);
      process.stderr.write(
        `huko: ref "${apiKeyRef}" recorded. To activate, set:\n` +
          `        export ${envName}="..."\n` +
          `      or in <cwd>/.env:  ${envName}=...\n` +
          `      Verify with: huko keys list\n`,
      );
    }

    // ── Step 5: default model ────────────────────────────────────────────
    const model = await pickModel(p, provider.name);
    persistModel(scope, cwd, model, /* setDefault */ true);

    // ── Step 6: summary ──────────────────────────────────────────────────
    printSummary(scope, provider.name, apiKeyRef, model, keyMode);
    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      process.stderr.write("\nhuko: setup cancelled\n");
      return 130;
    }
    process.stderr.write(`huko: setup failed: ${describe(err)}\n`);
    return 1;
  } finally {
    p.close();
  }
}

// ─── Step builders ──────────────────────────────────────────────────────────

async function pickScope(p: Prompter): Promise<Scope> {
  const items: SelectItem<Scope>[] = [
    {
      value: "global",
      label: "Global",
      hint: "~/.huko/providers.json — applies to every project on this machine",
    },
    {
      value: "project",
      label: "Project",
      hint: "<cwd>/.huko/providers.json — only this directory; commit-friendly",
    },
  ];
  return await p.select("Where should this configuration go?", items);
}

async function pickProvider(p: Prompter): Promise<ProviderConfig> {
  const cfg = loadInfraConfig({ cwd: process.cwd() });
  const items: SelectItem<ProviderConfig | null>[] = BUILTIN_PROVIDERS.map((p) => {
    const modelCount = cfg.models.filter((m) => m.providerName === p.name).length;
    return {
      value: p,
      label: p.name,
      hint: `${p.baseUrl}  [${modelCount} model${modelCount === 1 ? "" : "s"}]`,
    };
  });
  items.push({
    value: null,
    label: "(custom — not in built-ins)",
    hint: "private gateway, self-hosted, etc.",
  });

  const choice = await p.select("Pick a provider:", items);
  if (choice) return choice;

  // Custom-provider flow
  process.stderr.write("\nCustom provider — fill in the fields.\n");
  const name = await p.prompt("Provider name (lowercase identifier)", {
    validate: (v) => (/^[a-z0-9][a-z0-9_-]*$/.test(v) ? null : "lowercase letters, digits, _ or -"),
  });
  const protocolPick = await p.select<"openai" | "anthropic">(
    "Protocol:",
    [
      { value: "openai", label: "OpenAI-compatible (most providers)" },
      { value: "anthropic", label: "Anthropic-native" },
    ],
  );
  const baseUrl = await p.prompt("Base URL (e.g. https://api.example.com/v1)", {
    validate: (v) => (/^https?:\/\//.test(v) ? null : "must start with http:// or https://"),
  });
  return {
    name,
    protocol: protocolPick,
    baseUrl,
    apiKeyRef: name, // default; user can change in next step
  };
}

async function pickKeyRef(p: Prompter, provider: ProviderConfig): Promise<string> {
  // One-shot prompt: default = provider name (which maps to the
  // canonical env var). Press Enter to accept, or type a custom ref
  // for "personal vs work"-style splits. The custom name will be
  // uppercased into a fresh env var by envVarNameFor().
  const defaultEnvName = envVarNameFor(provider.name);
  process.stderr.write(
    `  Press Enter to use "${provider.name}" (env var ${defaultEnvName}),\n` +
      `  or type a custom ref to map to a different env var.\n`,
  );
  return await p.prompt("Ref name", {
    default: provider.name,
    validate: (v) => (v.trim() === "" ? "ref cannot be empty" : null),
  });
}

async function pickKeyMode(p: Prompter, providerName: string): Promise<KeyMode> {
  // The env-var hint here uses the *default* env name (provider name).
  // If the user picks "skip", we'll then offer to customise the ref —
  // which is what determines the actual env var name.
  const defaultEnvName = envVarNameFor(providerName);
  return await p.select<KeyMode>("Provide the API key — choose one:", [
    {
      value: "store",
      label: "Enter the key now",
      hint: "saved to keys.json (chmod 600), gitignored by default",
    },
    {
      value: "skip",
      label: "I'll set the env var myself",
      hint: `default env: ${defaultEnvName} (you can customise the ref next)`,
    },
  ]);
}

async function pickModel(p: Prompter, providerName: string): Promise<{
  modelId: string;
  displayName: string;
}> {
  const matches = BUILTIN_MODELS.filter((m) => m.providerName === providerName);
  const items: SelectItem<ModelConfig | null>[] = matches.map((m) => ({
    value: m,
    label: m.modelId,
    hint: m.displayName,
  }));
  items.push({
    value: null,
    label: "(enter a custom model id)",
    hint: "for models not in the built-in list",
  });

  const choice = await p.select<ModelConfig | null>("Pick a default model:", items);
  if (choice) return { modelId: choice.modelId, displayName: choice.displayName };

  const modelId = await p.prompt(`Enter ${providerName} model id`, {
    validate: (v) => (v.trim() === "" ? "model id cannot be empty" : null),
  });
  const displayName = await p.prompt("Display name (optional)", {
    default: modelId,
  });
  return { modelId, displayName };
}

// ─── Persisters ─────────────────────────────────────────────────────────────

function persistProvider(scope: Scope, cwd: string, provider: ProviderConfig): void {
  const file = scope === "global" ? readGlobalConfigFile() : readProjectConfigFile(cwd);
  const next: InfraConfigFile = { ...file };
  next.providers = [...(file.providers ?? [])];

  const idx = next.providers.findIndex((p) => p.name === provider.name);
  if (idx >= 0) next.providers[idx] = provider;
  else next.providers.push(provider);

  // If this provider name was disabled in this layer, undo that — the
  // user is explicitly asking for it back.
  if (next.disabledProviders) {
    next.disabledProviders = next.disabledProviders.filter((n) => n !== provider.name);
    if (next.disabledProviders.length === 0) delete next.disabledProviders;
  }

  if (scope === "global") writeGlobalConfigFile(next);
  else writeProjectConfigFile(cwd, next);
}

function persistModel(
  scope: Scope,
  cwd: string,
  model: { modelId: string; displayName: string },
  setDefault: boolean,
): void {
  const file = scope === "global" ? readGlobalConfigFile() : readProjectConfigFile(cwd);
  const next: InfraConfigFile = { ...file };
  next.models = [...(file.models ?? [])];

  // Find the provider name we just wrote (last entry tied to this scope).
  // We need it for the model's providerName field.
  const providerName = next.providers?.at(-1)?.name;
  if (!providerName) {
    throw new Error("internal: provider not persisted before model");
  }

  const composite: ModelConfig = {
    providerName,
    modelId: model.modelId,
    displayName: model.displayName,
  };

  const idx = next.models.findIndex(
    (m) => m.providerName === providerName && m.modelId === model.modelId,
  );
  if (idx >= 0) next.models[idx] = composite;
  else next.models.push(composite);

  if (next.disabledModels) {
    next.disabledModels = next.disabledModels.filter(
      (m) => !(m.providerName === providerName && m.modelId === model.modelId),
    );
    if (next.disabledModels.length === 0) delete next.disabledModels;
  }

  if (setDefault) {
    next.currentProvider = providerName;
    next.currentModel = model.modelId;
  }

  if (scope === "global") writeGlobalConfigFile(next);
  else writeProjectConfigFile(cwd, next);
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printSummary(
  scope: Scope,
  providerName: string,
  apiKeyRef: string,
  model: { modelId: string; displayName: string },
  keyMode: KeyMode,
): void {
  const ref = `${providerName}/${model.modelId}`;
  const keyTag = keyMode === "store" ? green("stored", "stderr") : yellow("expected from env", "stderr");
  process.stderr.write(
    "\n" + green("huko: setup complete.", "stderr") + "\n" +
      `      scope:         ${cyan(scope, "stderr")}\n` +
      `      provider:      ${cyan(providerName, "stderr")}\n` +
      `      key ref:       ${apiKeyRef} (${keyTag})\n` +
      `      current model: ${cyan(ref, "stderr")}\n` +
      "\n" + dim("Try it:  huko hello", "stderr") + "\n",
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
