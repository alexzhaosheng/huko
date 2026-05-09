/**
 * server/cli/dispatch/shared.ts
 *
 * Shared bits used by multiple per-resource dispatchers:
 *   - `usage(exitCode)`: prints the global help text and **throws**
 *     `CliExitError`. The single `process.exit()` site lives in
 *     `index.ts`; everywhere else, "exit now" is a typed exception
 *     so tests / embedders / future REPL composition aren't killed
 *     by deep stack frames.
 *   - `parseFormatFlags<F>(argv, validFormats, defaultFormat)`: pulls
 *     the standard `--format / --json / --jsonl` set out of argv.
 *     Used by `run`, `sessions list`, `provider list`, `model list`.
 *
 * Per-resource argv parsing is in the sibling `dispatch/<resource>.ts`
 * files; index.ts keeps only the top-level routing table.
 */

/**
 * Thrown by `usage()` and similar "stop now with this exit code" sites.
 *
 * Caught at exactly one place — `index.ts:main()` — which maps it to
 * the actual `process.exit(code)`. Anywhere else (tests, REPL host,
 * tRPC adapter) catches it and decides what to do with the code
 * without the process dying.
 */
export class CliExitError extends Error {
  readonly code: number;
  constructor(code: number, message?: string) {
    super(message ?? `huko exited with code ${code}`);
    this.code = code;
    this.name = "CliExitError";
  }
}

/**
 * Print the global help text and abort with `CliExitError(exitCode)`.
 *
 * `exitCode === 0` (user asked for `-h`/`--help`) → help goes to
 * **stdout** so it can be piped into `less`. Any other code is treated
 * as a usage error → help goes to **stderr** so stdout stays usable
 * for whatever the caller was trying to capture.
 */
export function usage(exitCode: number = 3): never {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(
    [
      "Usage: huko <command> [args] [options]",
      "",
      "Commands:",
      "  run <prompt>                  Append to active session (creates one if none)",
      "  sessions list                 List chat sessions in the local DB",
      "  sessions delete <id>          Delete a chat session and its tasks/entries",
      "  sessions current              Show the active chat-session id for this cwd",
      "  sessions switch <id>          Set <id> as the active session for this cwd",
      "  sessions new [opts]           Create a new (empty) session and set it active",
      "  provider list                 List configured LLM providers",
      "  provider add <flags>          Add a provider definition (no key value)",
      "  provider remove <id|name>     Delete a provider (cascades to its models)",
      "  model list                    List models linked to providers",
      "  model add <flags>             Add a model linked to a provider",
      "  model remove <id>             Delete a model",
      "  model default [<id>]          Show or set the system-default model",
      "  keys set <ref> <value>        Save a key to <cwd>/.huko/keys.json (chmod 600)",
      "  keys unset <ref>              Remove a key from <cwd>/.huko/keys.json",
      "  keys list                     Show every ref + which layer resolves it",
      "  config show                   Print the resolved huko config (layered)",
      "",
      "Options for `run`:",
      "  --format=<fmt>                text | jsonl | json   (default: text)",
      "  --json | --jsonl              Shortcuts for --format=...",
      "  --title=<text>                Title for the NEW session (if one is created)",
      "  --memory                      Both DBs in memory; state.json untouched",
      "  --role=<name>                 Role (default: coding)",
      "  --new                         Force a fresh session and switch active to it",
      "  --session=<id>                One-off send to <id>; active pointer untouched",
      "",
      "Options for `provider add`:",
      "  --name=<text>                 Display name (required)",
      "  --protocol=<openai|anthropic> Protocol (required)",
      "  --base-url=<url>              http(s) endpoint (required)",
      "  --api-key-ref=<name>          Logical key name (required); resolved at run",
      "                                time from <cwd>/.huko/keys.json | env | .env",
      "  --header=<K=V>                Repeatable; provider-default HTTP headers",
      "",
      "Options for `model add`:",
      "  --provider=<name|id>          Existing provider to link to (required)",
      "  --model-id=<vendor-id>        e.g. anthropic/claude-sonnet-4 (required)",
      "  --display-name=<text>         Defaults to --model-id",
      "  --think-level=<lvl>           off | low | medium | high (default: off)",
      "  --tool-call-mode=<mode>       native | xml (default: native)",
      "  --default                     Also set as system default model",
      "",
      "Options for `sessions list` / `provider list` / `model list`:",
      "  --format=<fmt>                text | jsonl | json   (default: text)",
      "",
      "Examples:",
      "  # one-time setup",
      '  huko provider add --name=OpenRouter --protocol=openai \\',
      '                    --base-url=https://openrouter.ai/api/v1 \\',
      '                    --api-key-ref=openrouter',
      "  huko keys set openrouter sk-or-...",
      '  huko model add --provider=OpenRouter \\',
      '                 --model-id=anthropic/claude-3.5-haiku --default',
      "",
      "  # daily use",
      '  huko run "What is 2 + 2?"             # continues the active session',
      '  huko run --new "new conversation"     # starts fresh, switches active',
      "  huko sessions current                 # who am I talking to?",
      "  huko sessions switch 7                # jump to session 7",
      "",
      "Exit codes:",
      "  0  ok / task done    1  failed    2  task stopped",
      "  3  usage error       4  target not found    5  lock contention",
      "",
    ].join("\n"),
  );
  throw new CliExitError(exitCode);
}

/**
 * Walk argv pulling out --format / --json / --jsonl flags.
 * Returns the resolved format and the leftover positional / flag args.
 *
 * Unknown `--<flag>` strings cause a usage error so typos fail loud.
 */
export function parseFormatFlags<F extends string>(
  argv: string[],
  validFormats: readonly F[],
  defaultFormat: F,
): { format: F; positional: string[] } {
  let format: F = defaultFormat;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      assertFormat("json", validFormats);
      format = "json" as F;
      continue;
    }
    if (arg === "--jsonl") {
      assertFormat("jsonl", validFormats);
      format = "jsonl" as F;
      continue;
    }
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      assertFormat(v, validFormats);
      format = v as F;
      continue;
    }
    if (arg.startsWith("--")) {
      process.stderr.write(`huko: unknown flag: ${arg}\n`);
      usage();
    }
    positional.push(arg);
  }

  return { format, positional };
}

function assertFormat<F extends string>(value: string, validFormats: readonly F[]): void {
  if (!validFormats.includes(value as F)) {
    process.stderr.write(
      `huko: invalid format value: ${value} (allowed: ${validFormats.join(", ")})\n`,
    );
    usage();
  }
}
