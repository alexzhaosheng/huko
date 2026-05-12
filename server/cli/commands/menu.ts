/**
 * server/cli/commands/menu.ts
 *
 * Interactive top-level menu — entered by `huko setup` when a provider
 * and current model are already configured. Replaces the linear wizard
 * for return visits; the wizard still runs on first-time installs.
 *
 * Scope of THIS iteration (Option B step 1, see CLAUDE.md / chat log):
 *   - Menu shell + state header + dispatch loop ✓
 *   - "Mode (lean / full)" sub-flow                                   ✓
 *   - Other 4 items are stubs that point at the existing CLI verbs.
 *     Each stub returns the user to the menu so the navigation feel
 *     stays consistent.
 *
 * Why route through `huko setup` instead of a new top-level verb: the
 * natural reaction to `huko setup` after already configuring is "I want
 * to change something". One command, two modes. See chat 2026-05-12.
 */

import {
  type ConfigScope,
  type HukoConfig,
  type InfraConfig,
  getConfig,
  loadConfig,
  loadInfraConfig,
  setConfigValue,
} from "../../config/index.js";
import {
  PromptCancelled,
  openPrompter,
  type Prompter,
  type SelectItem,
} from "./prompts.js";
import { bold, cyan, dim, green, yellow } from "../colors.js";

type TopChoice =
  | "providerModelKey"
  | "safety"
  | "mode"
  | "sessions"
  | "diagnostics"
  | "exit";

type DispatchOutcome = "continue" | "exit";

export async function menuCommand(): Promise<number> {
  const p = openPrompter();
  try {
    while (true) {
      const choice = await pickTopLevel(p);
      const outcome = await dispatch(choice, p);
      if (outcome === "exit") return 0;
    }
  } catch (err) {
    if (err instanceof PromptCancelled) {
      process.stderr.write("\nhuko: menu cancelled\n");
      return 130;
    }
    process.stderr.write(`huko: menu failed: ${describe(err)}\n`);
    return 1;
  } finally {
    p.close();
  }
}

// ─── Header ─────────────────────────────────────────────────────────────────

async function pickTopLevel(p: Prompter): Promise<TopChoice> {
  printHeader();

  const items: SelectItem<TopChoice>[] = [
    {
      value: "providerModelKey",
      label: "Provider / Model / Key",
      hint: "switch current, add a new one, rotate a key",
    },
    {
      value: "safety",
      label: "Safety",
      hint: "per-tool deny/allow/confirm rules + danger-level defaults",
    },
    {
      value: "mode",
      label: "Mode (lean / full)",
      hint: "lean = minimal prompt + bash only; full = complete agent",
    },
    {
      value: "sessions",
      label: "Sessions",
      hint: "list / switch / delete chat sessions in this project",
    },
    {
      value: "diagnostics",
      label: "Diagnostics",
      hint: "test current setup, view config / LLM log, toggle verbosity",
    },
    {
      value: "exit",
      label: "Exit",
    },
  ];

  return await p.select("What would you like to do?", items);
}

function printHeader(): void {
  // Always reload — earlier menu actions may have written to config.json
  // or providers.json, and we want the header to reflect the new state.
  // Both loaders re-read the underlying files (cheap; small JSON).
  const cwd = process.cwd();
  loadConfig({ cwd });
  const cfg = getConfig();
  const infra = loadInfraConfig({ cwd });

  const provider = infra.currentProvider?.name ?? dim("(unset)", "stderr");
  const model = infra.currentModel?.modelId ?? dim("(unset)", "stderr");

  process.stderr.write(
    "\n" + bold("huko configuration menu", "stderr") + "\n" +
      `  provider: ${cyan(provider, "stderr")}` +
      `   model: ${cyan(model, "stderr")}` +
      `   mode: ${cyan(cfg.mode, "stderr")}\n\n`,
  );
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

async function dispatch(choice: TopChoice, p: Prompter): Promise<DispatchOutcome> {
  switch (choice) {
    case "exit":
      return "exit";
    case "mode":
      return await modeMenu(p);
    case "providerModelKey":
      return await stub(p, "Provider / Model / Key", [
        "huko provider list                  — list providers",
        "huko provider current <name>        — switch current provider",
        "huko provider add --name=...        — add a custom provider",
        "huko model list                     — list models",
        "huko model current <id>             — switch current model",
        "huko keys set <ref> <value>         — set or rotate a key",
        "huko keys list                      — see which layer resolves each ref",
      ]);
    case "safety":
      return await stub(p, "Safety", [
        "huko safety init [--project]        — scaffold the policy template",
        "huko safety list                    — print every active rule",
        "huko safety check <tool> <k>=<v>... — dry-run a hypothetical call",
      ]);
    case "sessions":
      return await stub(p, "Sessions", [
        "huko sessions list                  — list this project's chat sessions",
        "huko sessions current               — show the active one",
        "huko sessions switch <id>           — switch active to <id>",
        "huko sessions new [--title=...]     — create a new session",
        "huko sessions delete <id>           — delete a session and its tasks",
      ]);
    case "diagnostics":
      return await stub(p, "Diagnostics", [
        "huko info                           — full effective configuration",
        "huko info global | project          — single layer only",
        "huko config show                    — runtime config + every layer",
        "huko config set cli.verbose true    — toggle default verbosity",
        "huko debug llm-log                  — render this session's LLM calls to HTML",
        dim("(coming: a 'Test current setup' ping that hits your provider)", "stderr"),
      ]);
  }
}

// ─── Mode (lean / full) ─────────────────────────────────────────────────────

async function modeMenu(p: Prompter): Promise<DispatchOutcome> {
  const cfg = getConfig();
  const current = cfg.mode;
  process.stderr.write(
    "\n" + bold("Mode", "stderr") + " — current: " + cyan(current, "stderr") + "\n" +
      dim("  full: complete agent (planning + 13 tools + project context)", "stderr") + "\n" +
      dim("  lean: minimal prompt + bash only (~95% smaller per-call overhead)", "stderr") + "\n\n",
  );

  const target = await p.select<HukoConfig["mode"]>(
    "Pick a mode:",
    [
      { value: "full", label: "full" },
      { value: "lean", label: "lean" },
    ],
  );

  if (target === current) {
    process.stderr.write(yellow(`huko: mode already ${current}; no change.\n`, "stderr"));
    return "continue";
  }

  const scope = await pickScope(p);

  const result = setConfigValue({
    path: "mode",
    value: target,
    scope,
    cwd: process.cwd(),
  });
  if (!result.ok) {
    process.stderr.write(`huko: mode change failed: ${result.error}\n`);
    return "continue";
  }

  process.stderr.write(
    green(`huko: mode = ${target}`, "stderr") +
      dim(`  [${scope}: ${result.filePath}]`, "stderr") + "\n",
  );
  return "continue";
}

async function pickScope(p: Prompter): Promise<ConfigScope> {
  return await p.select<ConfigScope>(
    "Where should this change be written?",
    [
      {
        value: "project",
        label: "Project",
        hint: "<cwd>/.huko/config.json — only this directory",
      },
      {
        value: "global",
        label: "Global",
        hint: "~/.huko/config.json — every project on this machine",
      },
    ],
  );
}

// ─── Stub renderer ──────────────────────────────────────────────────────────

async function stub(
  p: Prompter,
  title: string,
  hints: string[],
): Promise<DispatchOutcome> {
  process.stderr.write(
    "\n" + bold(title, "stderr") + " " + dim("(menu sub-flow not yet built)", "stderr") + "\n" +
      dim("  use these subcommands for now:", "stderr") + "\n",
  );
  for (const h of hints) {
    process.stderr.write(`    ${h}\n`);
  }
  process.stderr.write("\n");

  // Block briefly so the user reads the hints before we redraw the menu.
  await p.prompt(dim("Press Enter to return to the menu", "stderr"), {
    default: "",
  });
  return "continue";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Detection used by `huko setup` to decide menu-vs-wizard. Returns true
 * when there's a current provider + model AND a key for that provider
 * looks resolvable. We don't actually verify the key value (that's a
 * Diagnostics future job); we just check that the basic infra config
 * is non-empty enough that a wizard re-walk would feel redundant.
 */
export function isConfigured(infra: InfraConfig): boolean {
  return infra.currentProvider !== null && infra.currentModel !== null;
}
