/**
 * server/cli/dispatch/help.ts
 *
 * Help-banner content for `huko -h` / `huko --help` / argv-error
 * fallback. Lives in its own file so `dispatch/shared.ts` stays
 * focused on argv-parsing primitives (`parseFormatFlags`,
 * `CliExitError`) — editing the help text shouldn't ever touch the
 * parser. ~150 lines of static text is its own concern.
 *
 * The renderer takes a `ColorStream` so the same banner can paint
 * ANSI colour codes either for stdout (`huko -h`) or stderr
 * (argv-error path). Pure function: just returns a string.
 */

import { bold, type ColorStream, cyan, dim } from "../colors.js";
import { formatVersion } from "../../version.js";

const COL = 30;

export function renderHelpText(stream: ColorStream): string {
  const h = (s: string) => bold(s, stream);
  const c = (s: string) => cyan(s, stream);
  const d = (s: string) => dim(s, stream);

  function pad(s: string, w: number): string {
    return s.length >= w ? s + " " : s + " ".repeat(w - s.length);
  }
  function row(name: string, desc: string): string {
    return `  ${c(pad(name, COL - 2))} ${desc}`;
  }
  function rowWithDefault(name: string, desc: string, def: string): string {
    return `  ${c(pad(name, COL - 2))} ${desc} ${d(def)}`;
  }

  return [
    `${h("huko")}  ${d(formatVersion({ prefix: "" }).trim())}`,
    "",
    `${h("Usage:")} huko ${c("[flags]")} ${c("--")} ${c("<prompt>")}   — talk to the agent (the default)`,
    `       huko ${c("<subcommand>")} ...        — run a noun-verb command (setup, sessions, ...)`,
    `       huko ${c("--version")} (${c("-V")})         — print version and exit`,
    "",
    h("Commands:"),
    row("setup", "Interactive wizard: provider + key + model"),
    row("sessions list", "List chat sessions in the local DB"),
    row("sessions delete <id>", "Delete a chat session and its tasks/entries"),
    row("sessions current", "Show the active chat-session id for this cwd"),
    row("sessions switch <id>", "Set <id> as the active session for this cwd"),
    row("sessions new [opts]", "Create a new (empty) session and set it active"),
    row("provider list", "List configured LLM providers (merged view)"),
    row("provider add <flags>", `Add a provider; ${c("--project")} for project layer`),
    row("provider remove <name>", `Remove a provider; ${c("--project")} for project layer`),
    row("provider current [<name>]", "Show or set the current provider"),
    row("model list", "List models (merged view + source column)"),
    row("model add <flags>", `Add a model; ${c("--project")} for project layer`),
    row("model remove <ref>", "<ref> = providerName/modelId; --project supported"),
    row("model current [<modelId>]", "Show or set the current model (paired with provider)"),
    row("keys set <ref>", "Save a key (hidden prompt; --value <s> for scripting)"),
    row("keys unset <ref>", "Remove a key from project keys.json"),
    row("keys list", "Show every ref + which layer resolves it"),
    row("config show", "Print the resolved huko config (layered)"),
    row("config get <path>", "Read one config value + which layer set it"),
    row("config set <path> <value>", `Write a value; ${c("--project")} for project layer`),
    row("config unset <path>", `Remove a value; ${c("--project")} for project layer`),
    row("safety init", `Scaffold the per-tool safety policy template (${c("--global")} for global)`),
    row("safety tool", "List every registered tool + per-tool config (compact)"),
    row("safety list", "Print every active deny / allow / requireConfirm rule"),
    row("safety enable <tool>", "Re-add a previously disabled tool to the LLM surface"),
    row("safety disable <tool>", "Remove a tool from the LLM surface entirely"),
    row("safety deny <tool> <pat>", "Add a deny regex (refuses matching calls)"),
    row("safety allow <tool> <pat>", "Add an allow regex (bypasses requireConfirm + dangerLevel)"),
    row("safety require <tool> <pat>", "Add a requireConfirm regex (prompts the operator)"),
    row("safety unset <tool> [pat]", "Remove a pattern, or wipe the entire tool entry"),
    row("safety check <tool> <k>=<v>...", "Dry-run a hypothetical call against current rules"),
    `                                  ${d("editing verbs default to project; --global for global")}`,
    row("vault add <name>", `Register a secret in ${c("~/.huko/vault.json")} (hidden prompt)`),
    row("vault remove <name>", "Unregister a vault entry"),
    row("vault list", "Show vault entry names + lengths (never values)"),
    row("vault test", "Pipe text to stdin, see what scrubber would redact"),
    row("info [scope]", `Show full configuration (scope: ${c("global")} | ${c("project")})`),
    row("docker run [...]", "Run huko inside a container with cwd + ~/.huko mounted"),
    row("debug llm-log", "Render this session's LLM calls into huko_llm_log.html"),
    "",
    h("Prompt flags (default action — the agent loop):"),
    d("  Flags come BEFORE `--`; everything AFTER `--` is the prompt, taken verbatim."),
    d("  The `--` separator is required so that typo'd subcommands don't get sent to the LLM."),
    d("  Pipe-friendly: when stdin is piped/redirected, it's read as input data."),
    d("    `cat data | huko -- \"instruction\"` → instruction + data combined."),
    d("    `echo \"prompt\" | huko`             → stdin alone is the prompt."),
    d("    `huko -`                           → explicit stdin form (no argv prompt allowed)."),
    "",
    rowWithDefault("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    row("--json | --jsonl", "Shortcuts for --format=..."),
    row("--title=<text>", "Title for the NEW session (if one is created)"),
    row("--memory, -m", "Session DB in memory; state.json untouched"),
    row("--new, -n", "Force a fresh session and switch active to it"),
    row("--session=<id>", "One-off send to <id>; active pointer untouched"),
    row("--no-interaction, -y", "Disable mid-task user prompts (drops message(type=ask))"),
    row("--show-tokens", "Print input / cache / output token breakdown after run"),
    row("--lean", "One-call override: lean mode (minimal prompt + bash only)"),
    row("--no-markdown, --no-md", "Skip markdown→ANSI rendering; pass LLM output verbatim"),
    row("--verbose, -v", "Show tool_result content + system_reminder bodies"),
    row("--quiet", "Force quiet output (overrides config.cli.verbose=true)"),
    row("--chat, -c", "Interactive REPL — keep talking until /exit or Ctrl+D"),
    row("--enable=<feature>", "Force-enable a feature (repeatable)"),
    row("--disable=<feature>", "Force-disable a feature (repeatable)"),
    "",
    h("Features (opt-in; enable with --enable=<name>):"),
    d("  browser-control   Operate the user's real Chrome via an extension."),
    d("                    Chat mode only — one-shot runs never start sidecars."),
    d("                    Setup: load extensions/chrome/ in chrome://extensions"),
    d("                    Config: tools.browser.wsPort (default: 19222)"),
    d("                            tools.browser.defaultTimeoutMs (default: 30000)"),
    d("                            tools.browser.maxScreenshotBytes (default: 5242880)"),
    d("                    Change via: huko config set tools.browser.wsPort 19224 --project"),
    "",
    h("Options for `provider add`:"),
    row("--name=<text>", "Provider name (required)"),
    row("--protocol=<openai|anthropic>", "Protocol (required)"),
    row("--base-url=<url>", "http(s) endpoint (required)"),
    row("--api-key-ref=<name>", "Logical key name (required); resolved at run"),
    `                                  ${d("time from keys.json | env | .env")}`,
    row("--header=<K=V>", "Repeatable; provider-default HTTP headers"),
    row("--project", "Write to <cwd>/.huko/providers.json instead"),
    "",
    h("Options for `model add`:"),
    row("--provider=<name>", "Existing provider name (required)"),
    row("--model-id=<vendor-id>", "e.g. claude-sonnet-4-6 (required)"),
    row("--display-name=<text>", "Defaults to --model-id"),
    rowWithDefault("--think-level=<lvl>", "off | low | medium | high", "(default: off)"),
    rowWithDefault("--tool-call-mode=<mode>", "native | xml", "(default: native)"),
    row("--context-window=<n>", "Per-model token budget (overrides heuristic table)"),
    row("--current", "Also set as the current model (paired with provider)"),
    row("--project", "Write to <cwd>/.huko/providers.json instead"),
    "",
    h("Options for `sessions list` / `provider list` / `model list`:"),
    rowWithDefault("--format=<fmt>", "text | jsonl | json", "(default: text)"),
    "",
    h("Options for `debug llm-log`:"),
    row("--session=<id>", "Session id to dump (default: active session)"),
    row("--out=<path>", "Output path (default: <cwd>/huko_llm_log.html)"),
    "",
    h("Debug env vars:"),
    d("  HUKO_DEBUG_RAW_LLM=1           Capture raw HTTP request/response (JSONL)"),
    d("                                 to <cwd>/huko_llm_raw.jsonl"),
    d("  HUKO_DEBUG_RAW_LLM=<path>      Same, but write to <path>"),
    "",
    h("Examples:"),
    d("  # one-time setup (interactive wizard — recommended)"),
    `  ${c("huko setup")}`,
    "",
    d("  # daily use — flags first, then `--`, then the prompt"),
    `  ${c("huko -- fix the bug in main.ts")}                  ${d("# continues the active session")}`,
    `  ${c("huko --new -- explain how prompt caching works")}  ${d("# starts fresh, switches active")}`,
    `  ${c("huko --show-tokens -- analyse this CSV")}          ${d("# show token breakdown after")}`,
    `  ${c("huko --chat")}                                     ${d("# interactive REPL")}`,
    `  ${c("huko -- --metric correctness")}                    ${d("# prompt content may start with -")}`,
    "",
    d("  # pipe-friendly — combine stdin data with an instruction"),
    `  ${c("cat errors.log | huko -- extract the root cause > summary.txt")}`,
    `  ${c("git diff | huko -- review for risky changes")}`,
    `  ${c("echo 'tricky & shell | chars' | huko -")}          ${d("# `-` = stdin alone is the prompt")}`,
    `  ${c("huko < prompt.txt")}                               ${d("# read prompt from a file")}`,
    "",
    `  ${c("huko sessions current")}                           ${d("# noun-verb subcommands still work")}`,
    `  ${c("huko debug llm-log")}                              ${d("# inspect this session's LLM calls")}`,
    "",
    h("Exit codes:"),
    `  ${c("0")}   ok / task done    ${c("1")}   failed              ${c("2")}   task stopped`,
    `  ${c("3")}   usage error       ${c("4")}   target not found    ${c("5")}   lock contention`,
    `  ${c("130")} cancelled by user (Ctrl+C)`,
    "",
  ].join("\n");
}
