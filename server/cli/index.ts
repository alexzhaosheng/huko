#!/usr/bin/env node
/**
 * server/cli/index.ts
 *
 * `huko` CLI entry point.
 *
 * Subcommands implemented:
 *   - `run <prompt>`   one-shot task; prints assistant reply, exits.
 *
 * Coming later:
 *   - `start`          launch a daemon (HTTP + WS) in background
 *   - `send <prompt>`  fire a message at a running daemon
 *   - `chat`           interactive REPL backed by the daemon
 *   - `stop <taskId>`  signal a running task
 *   - `list sessions`  / `tasks` / `models`  inspectors
 *
 * Argv parser: hand-rolled (no commander/yargs) — small enough that
 * the dependency would be heavier than the parser.
 */

import { runCommand } from "./commands/run.js";
import type { FormatName } from "./formatters/index.js";

function usage(exitCode: number = 3): never {
  process.stderr.write(
    [
      "Usage: huko <command> [options] [args]",
      "",
      "Commands:",
      "  run <prompt>          Run a one-shot task with the given prompt",
      "",
      "Options for `run`:",
      "  --format=<fmt>        text | jsonl | json   (default: text)",
      "  --json                Shortcut for --format=json",
      "  --jsonl               Shortcut for --format=jsonl",
      "  -h, --help            Show this help",
      "",
      "Examples:",
      '  huko run "What is 2 + 2?"',
      '  huko run --jsonl "Summarize this" | jq \'select(.type == "tool_result")\'',
      '  RESULT=$(huko run --json "do X"); echo "$RESULT" | jq -r .final',
      "",
      "Exit codes:",
      "  0  task done    1  task failed    2  task stopped    3  usage error",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage(0);
  const head = argv[0]!;
  if (head === "-h" || head === "--help") usage(0);

  const cmd = head;
  const rest = argv.slice(1);

  if (cmd === "run") {
    let format: FormatName = "text";
    const positional: string[] = [];

    for (const arg of rest) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg === "--json") {
        format = "json";
        continue;
      }
      if (arg === "--jsonl") {
        format = "jsonl";
        continue;
      }
      if (arg.startsWith("--format=")) {
        const v = arg.slice("--format=".length);
        if (v !== "text" && v !== "jsonl" && v !== "json") {
          process.stderr.write(`huko: invalid --format value: ${v}\n`);
          usage();
        }
        format = v;
        continue;
      }
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }

    if (positional.length === 0) {
      process.stderr.write("huko run: prompt is required\n");
      usage();
    }
    const prompt = positional.join(" ");

    await runCommand({ prompt, format });
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
