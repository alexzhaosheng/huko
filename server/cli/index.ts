#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point.
 *
 * Subcommands implemented:
 *   - `run <prompt>`           one-shot task; prints assistant reply, exits.
 *   - `sessions list`          list chat sessions in the local DB.
 *   - `sessions delete <id>`   cascade-delete a chat session by id.
 *
 * Coming later:
 *   - `start`                  launch a daemon (HTTP + WS) in background
 *   - `send <prompt>`          fire a message at a running daemon
 *   - `chat`                   interactive REPL backed by the daemon
 *   - `stop <taskId>`          signal a running task
 *   - `sessions get <id>`      single-session detail
 *   - `tasks list`             task inspector (optionally scoped to session)
 *   - `models list`            configured models
 *   - `providers list`         configured providers
 *
 * Shape: noun-first (`<resource> <verb>`) — scales as we grow more verbs
 * per resource. Mirrors gh / docker / aws CLIs.
 *
 * Argv parser: hand-rolled (no commander/yargs) — small enough that
 * the dependency would be heavier than the parser.
 */

import { runCommand } from "./commands/run.js";
import {
  sessionsListCommand,
  sessionsDeleteCommand,
  type OutputFormat,
} from "./commands/sessions.js";
import type { FormatName } from "./formatters/index.js";

function usage(exitCode: number = 3): never {
  process.stderr.write(
    [
      "Usage: huko <command> [args] [options]",
      "",
      "Commands:",
      "  run <prompt>              Run a one-shot task with the given prompt",
      "  sessions list             List chat sessions in the local DB",
      "  sessions delete <id>      Delete a chat session and its tasks/entries",
      "",
      "Options for `run`:",
      "  --format=<fmt>            text | jsonl | json   (default: text)",
      "  --json                    Shortcut for --format=json",
      "  --jsonl                   Shortcut for --format=jsonl",
      "  --title=<text>            Override the chat-session title",
      "                            (default: first ~40 chars of the prompt)",
      "  --memory                  Run ephemerally — session/messages are NOT",
      "                            written to disk. Provider/model config is",
      "                            still read from huko.db at startup.",
      "  -h, --help                Show this help",
      "",
      "Options for `sessions list`:",
      "  --format=<fmt>            text | jsonl | json   (default: text)",
      "  --json                    Shortcut for --format=json",
      "  --jsonl                   Shortcut for --format=jsonl",
      "",
      "Examples:",
      '  huko run "What is 2 + 2?"',
      '  huko run --jsonl "Summarize this" | jq \'select(.type == "tool_result")\'',
      '  RESULT=$(huko run --json "do X"); echo "$RESULT" | jq -r .final',
      '  huko run --title="ad-hoc Q" "What is the weather today?"',
      '  huko run --memory "private question that should not persist"',
      "  huko sessions list",
      "  huko sessions list --json | jq '.[0]'",
      "  huko sessions delete 12",
      "",
      "Exit codes:",
      "  0  ok / task done    1  failed    2  task stopped",
      "  3  usage error       4  target not found",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/**
 * Walk argv pulling out --format / --json / --jsonl flags.
 * Returns the resolved format and the leftover positional / flag args.
 *
 * Unknown `--<flag>` strings cause a usage error so typos fail loud.
 */
function parseFormatFlags<F extends string>(
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

// ─── run command ─────────────────────────────────────────────────────────────

async function dispatchRun(rest: string[]): Promise<void> {
  // Pre-extract run-specific flags before generic flag parsing —
  // parseFormatFlags rejects unknown --xxx flags loudly.
  let title: string | undefined;
  let ephemeral = false;
  const filtered: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
      continue;
    }
    if (arg === "--memory") {
      ephemeral = true;
      continue;
    }
    filtered.push(arg);
  }

  const { format, positional } = parseFormatFlags<FormatName>(
    filtered,
    ["text", "jsonl", "json"],
    "text",
  );

  if (positional.length === 0) {
    process.stderr.write("huko run: prompt is required\n");
    usage();
  }
  const prompt = positional.join(" ");

  await runCommand({
    prompt,
    format,
    ...(title !== undefined ? { title } : {}),
    ...(ephemeral ? { ephemeral: true } : {}),
  });
}

// ─── sessions <verb> ─────────────────────────────────────────────────────────

async function dispatchSessions(rest: string[]): Promise<void> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko sessions: missing verb (list | delete)\n"
        : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "list") {
    const { format, positional } = parseFormatFlags<OutputFormat>(
      rest.slice(1),
      ["text", "jsonl", "json"],
      "text",
    );
    if (positional.length > 0) {
      process.stderr.write(
        `huko sessions list: unexpected argument: ${positional[0]}\n`,
      );
      usage();
    }
    await sessionsListCommand({ format });
    return;
  }

  if (verb === "delete") {
    const positional: string[] = [];
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }
    if (positional.length !== 1) {
      process.stderr.write("huko sessions delete: expected exactly one <id>\n");
      usage();
    }
    const idRaw = positional[0]!;
    const id = Number(idRaw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      process.stderr.write(`huko sessions delete: invalid id: ${idRaw}\n`);
      usage();
    }
    await sessionsDeleteCommand({ id });
    return;
  }

  process.stderr.write(`huko sessions: unknown verb: ${verb}\n`);
  usage();
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage(0);
  const head = argv[0]!;
  if (head === "-h" || head === "--help") usage(0);

  const cmd = head;
  const rest = argv.slice(1);

  if (cmd === "run") {
    await dispatchRun(rest);
    return;
  }

  if (cmd === "sessions") {
    await dispatchSessions(rest);
    return;
  }

  process.stderr.write(`huko: unknown command: ${cmd}\n`);
  usage();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`huko: fatal: ${msg}\n`);
  process.exit(1);
});
