/**
 * server/cli/dispatch/run.ts
 *
 * `huko run <prompt> [flags]` — argv parser + handoff to runCommand.
 *
 * Pre-extracts run-specific flags (`--title`, `--memory`, `--role`,
 * `--new`, `--session=<id>`) before passing the rest through the
 * generic format-flag parser. Unknown flags fail loud at format-flag
 * stage.
 */

import { runCommand } from "../commands/run.js";
import type { FormatName } from "../formatters/index.js";
import { parseFormatFlags, usage } from "./shared.js";

export async function dispatchRun(rest: string[]): Promise<void> {
  let title: string | undefined;
  let ephemeral = false;
  let role: string | undefined;
  let newSession = false;
  let sessionId: number | undefined;
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
    if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length);
      continue;
    }
    if (arg === "--new") {
      newSession = true;
      continue;
    }
    if (arg.startsWith("--session=")) {
      const raw = arg.slice("--session=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        process.stderr.write(`huko run: invalid --session value: ${raw}\n`);
        usage();
      }
      sessionId = n;
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
    ...(role !== undefined ? { role } : {}),
    ...(newSession ? { newSession: true } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}
