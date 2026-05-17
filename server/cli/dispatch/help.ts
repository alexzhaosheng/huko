/**
 * server/cli/dispatch/help.ts
 *
 * Help banners — split into a small top-level overview plus one
 * renderer per noun-verb subcommand category. `usage()` (in shared.ts)
 * picks the renderer; each dispatcher passes its own.
 *
 * The renderers all take a `ColorStream` so the same banner can paint
 * ANSI colour codes either for stdout (`-h` path, success) or stderr
 * (argv-error path). Each renderer is a pure function returning a string.
 *
 * Layering:
 *   - `renderTopHelp` — what `huko -h` shows by default. Minimal: usage
 *     examples, daily-use flags, a one-line index of subcommand
 *     categories. Designed to fit in a single terminal screen.
 *   - `renderFullHelp` — the legacy everything-in-one-page dump. Reached
 *     via `huko -h --all` so power users / grep workflows still have it.
 *   - `render<Noun>Help` — one per subcommand category, scoped to the
 *     verbs + options that category exposes. Reached via `huko <noun>`
 *     (no verb) or `huko <noun> -h`.
 */

import { bold, type ColorStream, cyan, dim } from "../colors.js";
import { formatVersion } from "../../version.js";

const COL = 30;

function h(stream: ColorStream): (s: string) => string {
  return (s) => bold(s, stream);
}
function c(stream: ColorStream): (s: string) => string {
  return (s) => cyan(s, stream);
}
function d(stream: ColorStream): (s: string) => string {
  return (s) => dim(s, stream);
}
function pad(s: string, w: number): string {
  return s.length >= w ? s + " " : s + " ".repeat(w - s.length);
}
function row(stream: ColorStream): (name: string, desc: string) => string {
  const colour = c(stream);
  return (name, desc) => `  ${colour(pad(name, COL - 2))} ${desc}`;
}
function rowWithDefault(stream: ColorStream): (name: string, desc: string, def: string) => string {
  const colour = c(stream);
  const dimmer = d(stream);
  return (name, desc, def) => `  ${colour(pad(name, COL - 2))} ${desc} ${dimmer(def)}`;
}

// ─── Top-level (the new short default) ──────────────────────────────────────

export function renderTopHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);

  return [
    `${H("huko")}  ${D(formatVersion({ prefix: "" }).trim())}`,
    "",
    `${H("Usage:")} huko ${C("[flags]")} ${C("--")} ${C("<prompt>")}   — talk to the agent (the default action)`,
    `       huko ${C("--chat")}                       — interactive REPL`,
    `       huko ${C("<subcommand>")} ${C("-h")}              — drill into a subcommand's help`,
    `       huko ${C("-h --all")}                     — show the full reference (all flags + verbs)`,
    `       huko ${C("--version")} (${C("-V")})                — print version`,
    "",
    H("Daily-use flags (the agent loop):"),
    R("--chat, -c", "Interactive REPL — keep talking until /exit or Ctrl+D"),
    R("--new, -n", "Force a fresh session and switch active to it"),
    R("--memory, -m", "Session DB in memory; state.json untouched"),
    R("--session=<id>", "One-off send to <id>; active pointer untouched"),
    R("--no-interaction, -y", "Disable mid-task user prompts (drops message(type=ask))"),
    R("--show-tokens", "Print input / cache / output token breakdown"),
    R("--skill=<name>", "Activate an operator-authored skill (repeatable)"),
    R("--compact=<level>", "Compaction preset: concise | standard | extended | large | max"),
    R("--enable=<feature>", "Force-enable a feature (repeatable; see below)"),
    R("--disable=<feature>", "Force-disable a feature (repeatable)"),
    "",
    H("Features (opt-in; activate with --enable=<name>):"),
    D("  browser-control   Operate the user's real Chrome via an extension (chat mode only)."),
    D("                    Setup: load extensions/chrome/ in chrome://extensions, then"),
    D("                    `huko --chat --enable=browser-control`. Tune via"),
    D("                    `huko config set tools.browser.wsPort <port> --project` etc."),
    "",
    H("Subcommands (run `huko <name> -h` for details):"),
    R("setup", "Interactive first-run wizard: provider + key + model"),
    R("sessions", "Manage chat sessions stored in the local DB"),
    R("provider", "Configure LLM providers (add / remove / current / list)"),
    R("model", "Configure models (add / show / update / remove / current / list)"),
    R("keys", "Manage API key refs (set / unset / list)"),
    R("config", "Read or write the layered runtime config"),
    R("safety", "Per-tool safety policy (allow / deny / requireConfirm)"),
    R("vault", "Register secret values for the redaction layer"),
    R("skills", "Discover operator-authored skill files"),
    R("info", "Show full configuration (global or project scope)"),
    R("docker", "Run huko inside a sandbox container"),
    R("debug", "Diagnostic tooling (e.g. dump this session's LLM calls)"),
    "",
    H("Examples:"),
    `  ${C("huko -- fix the bug in main.ts")}`,
    `  ${C("huko --chat")}                                     ${D("# REPL")}`,
    `  ${C("cat data.log | huko -- extract root cause")}       ${D("# pipe + instruction")}`,
    `  ${C("huko sessions list")}                              ${D("# subcommand")}`,
    "",
    H("Exit codes:"),
    `  ${C("0")}   ok / task done    ${C("1")}   failed              ${C("2")}   task stopped`,
    `  ${C("3")}   usage error       ${C("4")}   target not found    ${C("5")}   lock contention`,
    `  ${C("130")} cancelled by user (Ctrl+C)`,
    "",
  ].join("\n");
}

// ─── Full reference (legacy dump; reached via -h --all) ─────────────────────

export function renderFullHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);
  const RD = rowWithDefault(stream);

  return [
    `${H("huko")}  ${D(formatVersion({ prefix: "" }).trim())}`,
    "",
    `${H("Usage:")} huko ${C("[flags]")} ${C("--")} ${C("<prompt>")}   — talk to the agent (the default)`,
    `       huko ${C("<subcommand>")} ...        — run a noun-verb command (setup, sessions, ...)`,
    `       huko ${C("--version")} (${C("-V")})         — print version and exit`,
    "",
    H("Commands:"),
    R("setup", "Interactive wizard: provider + key + model"),
    R("sessions list", "List chat sessions in the local DB"),
    R("sessions delete <id>", "Delete a chat session and its tasks/entries"),
    R("sessions current", "Show the active chat-session id for this cwd"),
    R("sessions switch <id>", "Set <id> as the active session for this cwd"),
    R("sessions new [opts]", "Create a new (empty) session and set it active"),
    R("skills list", "List operator-authored skills + active state"),
    R("provider list", "List configured LLM providers (merged view)"),
    R("provider add <flags>", `Add a provider; ${C("--project")} for project layer`),
    R("provider remove <name>", `Remove a provider; ${C("--project")} for project layer`),
    R("provider current [<name>]", "Show or set the current provider"),
    R("model list", "List models (merged view + source column)"),
    R("model show <ref>", "Show full record for a single model (incl. effective context window)"),
    R("model add <flags>", `Add a model; ${C("--project")} for project layer`),
    R("model update <ref> <flags>", "Patch fields on an existing model (e.g. --context-window)"),
    R("model remove <ref>", "<ref> = providerName/modelId; --project supported"),
    R("model current [<modelId>]", "Show or set the current model (paired with provider)"),
    R("keys set <ref>", "Save a key (hidden prompt; --value <s> for scripting)"),
    R("keys unset <ref>", "Remove a key from project keys.json"),
    R("keys list", "Show every ref + which layer resolves it"),
    R("config show", "Print the resolved huko config (layered)"),
    R("config get <path>", "Read one config value + which layer set it"),
    R("config set <path> <value>", `Write a value; ${C("--project")} for project layer`),
    R("config unset <path>", `Remove a value; ${C("--project")} for project layer`),
    R("safety init", `Scaffold the per-tool safety policy template (${C("--global")} for global)`),
    R("safety tool", "List every registered tool + per-tool config (compact)"),
    R("safety list", "Print every active deny / allow / requireConfirm rule"),
    R("safety enable <tool>", "Re-add a previously disabled tool to the LLM surface"),
    R("safety disable <tool>", "Remove a tool from the LLM surface entirely"),
    R("safety deny <tool> <pat>", "Add a deny regex (refuses matching calls)"),
    R("safety allow <tool> <pat>", "Add an allow regex (bypasses requireConfirm + dangerLevel)"),
    R("safety require <tool> <pat>", "Add a requireConfirm regex (prompts the operator)"),
    R("safety unset <tool> [pat]", "Remove a pattern, or wipe the entire tool entry"),
    R("safety check <tool> <k>=<v>...", "Dry-run a hypothetical call against current rules"),
    `                                  ${D("editing verbs default to project; --global for global")}`,
    R("vault add <name>", `Register a secret in ${C("~/.huko/vault.json")} (hidden prompt)`),
    R("vault remove <name>", "Unregister a vault entry"),
    R("vault list", "Show vault entry names + lengths (never values)"),
    R("vault test", "Pipe text to stdin, see what scrubber would redact"),
    R("info [scope]", `Show full configuration (scope: ${C("global")} | ${C("project")})`),
    R("docker run [...]", "Run huko inside a container with cwd + ~/.huko mounted"),
    R("debug llm-log", "Render this session's LLM calls into huko_llm_log.html"),
    "",
    H("Prompt flags (default action — the agent loop):"),
    D("  Flags come BEFORE `--`; everything AFTER `--` is the prompt, taken verbatim."),
    D("  The `--` separator is required so that typo'd subcommands don't get sent to the LLM."),
    D("  Pipe-friendly: when stdin is piped/redirected, it's read as input data."),
    D("    `cat data | huko -- \"instruction\"` → instruction + data combined."),
    D("    `echo \"prompt\" | huko`             → stdin alone is the prompt."),
    D("    `huko -`                           → explicit stdin form (no argv prompt allowed)."),
    "",
    RD("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    R("--json | --jsonl", "Shortcuts for --format=..."),
    R("--title=<text>", "Title for the NEW session (if one is created)"),
    R("--memory, -m", "Session DB in memory; state.json untouched"),
    R("--new, -n", "Force a fresh session and switch active to it"),
    R("--session=<id>", "One-off send to <id>; active pointer untouched"),
    R("--no-interaction, -y", "Disable mid-task user prompts (drops message(type=ask))"),
    R("--show-tokens", "Print input / cache / output token breakdown after run"),
    R("--lean", "One-call override: lean mode (minimal prompt + bash only)"),
    R("--no-markdown, --no-md", "Skip markdown→ANSI rendering; pass LLM output verbatim"),
    R("--verbose, -v", "Show tool_result content + system_reminder bodies"),
    R("--quiet", "Force quiet output (overrides config.cli.verbose=true)"),
    R("--chat, -c", "Interactive REPL — keep talking until /exit or Ctrl+D"),
    R("--enable=<feature>", "Force-enable a feature (repeatable)"),
    R("--disable=<feature>", "Force-disable a feature (repeatable)"),
    R("--compact=<level>", "Compaction preset: concise | standard | extended | large | max"),
    R("--compact-threshold=<n>", "Raw trigger ratio (0.05..0.99); switches to custom mode (overrides --compact)"),
    R("--skill=<name>", "Activate a skill for this run (repeatable; stacks on config)"),
    "",
    H("Features (opt-in; enable with --enable=<name>):"),
    D("  browser-control   Operate the user's real Chrome via an extension."),
    D("                    Chat mode only — one-shot runs never start sidecars."),
    D("                    Setup: load extensions/chrome/ in chrome://extensions"),
    D("                    Config: tools.browser.wsPort (default: 19222)"),
    D("                            tools.browser.defaultTimeoutMs (default: 30000)"),
    D("                            tools.browser.maxScreenshotBytes (default: 5242880)"),
    D("                    Change via: huko config set tools.browser.wsPort 19224 --project"),
    "",
    H("Options for `provider add`:"),
    R("--name=<text>", "Provider name (required)"),
    R("--protocol=<openai|anthropic>", "Protocol (required)"),
    R("--base-url=<url>", "http(s) endpoint (required)"),
    R("--api-key-ref=<name>", "Logical key name (required); resolved at run"),
    `                                  ${D("time from keys.json | env | .env")}`,
    R("--header=<K=V>", "Repeatable; provider-default HTTP headers"),
    R("--project", "Write to <cwd>/.huko/providers.json instead"),
    "",
    H("Options for `model add`:"),
    R("--provider=<name>", "Existing provider name (required)"),
    R("--model-id=<vendor-id>", "e.g. claude-sonnet-4-6 (required)"),
    R("--display-name=<text>", "Defaults to --model-id"),
    RD("--think-level=<lvl>", "off | low | medium | high", "(default: off)"),
    RD("--tool-call-mode=<mode>", "native | xml", "(default: native)"),
    R("--context-window=<n>", "Per-model token budget (overrides heuristic table)"),
    R("--current", "Also set as the current model (paired with provider)"),
    R("--project", "Write to <cwd>/.huko/providers.json instead"),
    "",
    H("Options for `sessions list` / `provider list` / `model list`:"),
    RD("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    "",
    H("Options for `debug llm-log`:"),
    R("--session=<id>", "Session id to dump (default: active session)"),
    R("--out=<path>", "Output path (default: <cwd>/huko_llm_log.html)"),
    "",
    H("Debug env vars:"),
    D("  HUKO_DEBUG_RAW_LLM=1           Capture raw HTTP request/response (JSONL)"),
    D("                                 to <cwd>/huko_llm_raw.jsonl"),
    D("  HUKO_DEBUG_RAW_LLM=<path>      Same, but write to <path>"),
    "",
    H("Examples:"),
    D("  # one-time setup (interactive wizard — recommended)"),
    `  ${C("huko setup")}`,
    "",
    D("  # daily use — flags first, then `--`, then the prompt"),
    `  ${C("huko -- fix the bug in main.ts")}                  ${D("# continues the active session")}`,
    `  ${C("huko --new -- explain how prompt caching works")}  ${D("# starts fresh, switches active")}`,
    `  ${C("huko --show-tokens -- analyse this CSV")}          ${D("# show token breakdown after")}`,
    `  ${C("huko --chat")}                                     ${D("# interactive REPL")}`,
    `  ${C("huko -- --metric correctness")}                    ${D("# prompt content may start with -")}`,
    "",
    D("  # pipe-friendly — combine stdin data with an instruction"),
    `  ${C("cat errors.log | huko -- extract the root cause > summary.txt")}`,
    `  ${C("git diff | huko -- review for risky changes")}`,
    `  ${C("echo 'tricky & shell | chars' | huko -")}          ${D("# `-` = stdin alone is the prompt")}`,
    `  ${C("huko < prompt.txt")}                               ${D("# read prompt from a file")}`,
    "",
    `  ${C("huko sessions current")}                           ${D("# noun-verb subcommands still work")}`,
    `  ${C("huko debug llm-log")}                              ${D("# inspect this session's LLM calls")}`,
    "",
    H("Exit codes:"),
    `  ${C("0")}   ok / task done    ${C("1")}   failed              ${C("2")}   task stopped`,
    `  ${C("3")}   usage error       ${C("4")}   target not found    ${C("5")}   lock contention`,
    `  ${C("130")} cancelled by user (Ctrl+C)`,
    "",
  ].join("\n");
}

// ─── Per-subcommand renderers ───────────────────────────────────────────────

export function renderSessionsHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  const RD = rowWithDefault(stream);
  return [
    `${H("huko sessions")} — manage chat sessions stored in the project's local DB`,
    "",
    `${H("Usage:")} huko sessions ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("list", "List every chat session in the local DB"),
    R("delete <id>", "Delete a chat session and its tasks/entries"),
    R("current", "Show the active chat-session id for this cwd"),
    R("switch <id>", "Set <id> as the active session for this cwd"),
    R("new [--title=<text>]", "Create a new (empty) session and set it active"),
    "",
    H("Options for `list`:"),
    RD("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    "",
  ].join("\n");
}

export function renderProviderHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);
  const RD = rowWithDefault(stream);
  return [
    `${H("huko provider")} — configure LLM providers (layered: global + project)`,
    "",
    `${H("Usage:")} huko provider ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("list", "Print configured providers (merged view + source column)"),
    R("add <flags>", `Register a new provider (${C("--project")} writes to project layer)`),
    R("remove <name>", `Remove a provider (${C("--project")} for project layer)`),
    R("current [<name>]", "Show or set the current provider"),
    "",
    H("Options for `add`:"),
    R("--name=<text>", "Provider name (required)"),
    R("--protocol=<openai|anthropic>", "Protocol (required)"),
    R("--base-url=<url>", "http(s) endpoint (required)"),
    R("--api-key-ref=<name>", "Logical key name (required); resolved at runtime"),
    `                                  ${D("from keys.json → env → .env")}`,
    R("--header=<K=V>", "Repeatable; provider-default HTTP headers"),
    R("--project", "Write to <cwd>/.huko/providers.json (default: global)"),
    "",
    H("Options for `list`:"),
    RD("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    "",
  ].join("\n");
}

export function renderModelHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  const RD = rowWithDefault(stream);
  return [
    `${H("huko model")} — configure models (paired with a provider; layered global/project)`,
    "",
    `${H("Usage:")} huko model ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("list", "Print models (merged view + source column)"),
    R("show <ref>", "Show one model's full record + effective context window"),
    R("add <flags>", `Register a new model (${C("--project")} for project layer)`),
    R("update <ref> <flags>", "Patch fields on an existing model"),
    R("remove <ref>", "<ref> = providerName/modelId"),
    R("current [<modelId>]", "Show or set the current model"),
    "",
    H("Options for `add` / `update`:"),
    R("--provider=<name>", "Existing provider name (required for add)"),
    R("--model-id=<vendor-id>", "e.g. claude-sonnet-4-6 (required for add)"),
    R("--display-name=<text>", "Defaults to --model-id"),
    RD("--think-level=<lvl>", "off | low | medium | high", "(default: off)"),
    RD("--tool-call-mode=<mode>", "native | xml", "(default: native)"),
    R("--context-window=<n>", "Per-model token budget (overrides heuristic table)"),
    R("--current", "Also set as the current model (paired with provider)"),
    R("--project", "Write to <cwd>/.huko/providers.json (default: global)"),
    "",
    H("Options for `list`:"),
    RD("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    "",
  ].join("\n");
}

export function renderKeysHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  return [
    `${H("huko keys")} — manage API key refs (real values resolved from keys.json | env | .env)`,
    "",
    `${H("Usage:")} huko keys ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("set <ref>", "Save a key (hidden prompt; --value <s> for scripting)"),
    R("unset <ref>", "Remove a key from project keys.json"),
    R("list", "Show every ref + which layer resolves it"),
    "",
    H("Options for `set`:"),
    R("--value=<text>", "Provide the value via argv (skip the hidden prompt)"),
    "",
  ].join("\n");
}

export function renderConfigHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  return [
    `${H("huko config")} — read or write the layered runtime config`,
    "",
    `${H("Usage:")} huko config ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("show", "Print the fully resolved config (default → global → project → env → explicit)"),
    R("get <path>", "Read one value at a dotted path (e.g. compaction.thresholdRatio)"),
    R("set <path> <value>", `Write a value (${C("--project")} for project layer; default: global)`),
    R("unset <path>", `Remove a value (${C("--project")} for project layer)`),
    "",
  ].join("\n");
}

export function renderSafetyHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);
  return [
    `${H("huko safety")} — per-tool safety policy (allow / deny / requireConfirm)`,
    "",
    `${H("Usage:")} huko safety ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("init", `Scaffold the policy template (${C("--global")} for global; default: project)`),
    R("tool", "List every registered tool + its current config"),
    R("list", "Print every active deny / allow / requireConfirm rule"),
    R("enable <tool>", "Re-add a previously disabled tool to the LLM surface"),
    R("disable <tool>", "Remove a tool from the LLM surface entirely"),
    R("deny <tool> <pat>", "Add a deny regex (refuses matching calls)"),
    R("allow <tool> <pat>", "Add an allow regex (bypasses requireConfirm + dangerLevel)"),
    R("require <tool> <pat>", "Add a requireConfirm regex (prompts the operator)"),
    R("unset <tool> [pat]", "Remove a pattern, or wipe the entire tool entry"),
    R("check <tool> <k>=<v>...", "Dry-run a hypothetical call against current rules"),
    "",
    D("Editing verbs default to project; pass --global to write the user layer."),
    "",
  ].join("\n");
}

export function renderVaultHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  return [
    `${H("huko vault")} — register secret values for the redaction layer`,
    "",
    `${H("Usage:")} huko vault ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("add <name>", `Register a secret in ${C("~/.huko/vault.json")} (hidden prompt)`),
    R("remove <name>", "Unregister a vault entry"),
    R("list", "Show vault entry names + lengths (never values)"),
    R("test", "Pipe text to stdin, see what scrubber would redact"),
    "",
  ].join("\n");
}

export function renderInfoHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  return [
    `${H("huko info")} — show the resolved configuration for a scope`,
    "",
    `${H("Usage:")} huko info ${C("[scope]")}`,
    "",
    H("Scopes:"),
    R("(no arg)", "Show the full effective config (merged across all layers)"),
    R("global", "Show only ~/.huko/* contents"),
    R("project", "Show only <cwd>/.huko/* contents"),
    "",
  ].join("\n");
}

export function renderSetupHelp(stream: ColorStream): string {
  const H = h(stream);
  return [
    `${H("huko setup")} — interactive first-run wizard`,
    "",
    `${H("Usage:")} huko setup`,
    "",
    "Walks through: pick a provider, supply an API key, pick a model, set it as current.",
    "All choices write to the layered config (global by default).",
    "",
  ].join("\n");
}

export function renderDebugHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);
  return [
    `${H("huko debug")} — diagnostic tooling`,
    "",
    `${H("Usage:")} huko debug ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("llm-log", "Render this session's LLM calls into huko_llm_log.html"),
    "",
    H("Options for `llm-log`:"),
    R("--session=<id>", "Session id to dump (default: active session)"),
    R("--out=<path>", "Output path (default: <cwd>/huko_llm_log.html)"),
    "",
    H("Debug env vars:"),
    D("  HUKO_DEBUG_RAW_LLM=1           Capture raw HTTP request/response (JSONL)"),
    D("                                 to <cwd>/huko_llm_raw.jsonl"),
    D("  HUKO_DEBUG_RAW_LLM=<path>      Same, but write to <path>"),
    "",
  ].join("\n");
}

export function renderDockerHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const R = row(stream);
  return [
    `${H("huko docker")} — run huko inside a sandbox container`,
    "",
    `${H("Usage:")} huko docker ${C("run")} ${C("[huko args...]")}`,
    "",
    H("Verbs:"),
    R("run [...]", "Run huko in a container with cwd + ~/.huko bind-mounted"),
    "",
    "All arguments after `run` are forwarded to huko inside the container.",
    "Example: `huko docker run --chat`",
    "",
  ].join("\n");
}

export function renderSkillsHelp(stream: ColorStream): string {
  const H = h(stream);
  const C = c(stream);
  const D = d(stream);
  const R = row(stream);
  return [
    `${H("huko skills")} — discover operator-authored skill files`,
    "",
    `${H("Usage:")} huko skills ${C("<verb>")} ...`,
    "",
    H("Verbs:"),
    R("list", "List every discoverable skill + its active state"),
    "",
    "Authoring: drop a markdown file at one of these paths, then enable it.",
    D("  ~/.huko/skills/<name>.md           (global, single file)"),
    D("  ~/.huko/skills/<name>/SKILL.md     (global, folder-style)"),
    D("  <cwd>/.huko/skills/<name>.md       (project — wins over global)"),
    D("  <cwd>/.huko/skills/<name>/SKILL.md (project, folder-style)"),
    "",
    "Activation (additive):",
    D("  huko config set skills.<name>.enabled true            # persist globally"),
    D("  huko config set skills.<name>.enabled true --project  # persist per project"),
    D("  huko --skill=<name> -- ...                            # one-shot, repeatable"),
    "",
  ].join("\n");
}
