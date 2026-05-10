/**
 * server/cli/dispatch/debug.ts
 *
 * `huko debug <subcommand>` — diagnostic / inspection commands. The
 * dispatcher is a thin router; argv parsing for each subcommand stays
 * here.
 *
 * Subcommands (extend by adding cases):
 *   - `llm-log` — render the current session's LLM call log as HTML
 */

import {
  debugLlmLogCommand,
  type DebugLlmLogArgs,
} from "../commands/debug-llm-log.js";
import { usage } from "./shared.js";

export async function dispatchDebug(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko debug: missing subcommand (llm-log)\n"
        : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "llm-log") {
    return await dispatchLlmLog(rest.slice(1));
  }

  process.stderr.write(`huko debug: unknown subcommand: ${verb}\n`);
  usage();
}

// ─── llm-log ───────────────────────────────────────────────────────────────

async function dispatchLlmLog(rest: string[]): Promise<number> {
  const args: DebugLlmLogArgs = {};
  for (const a of rest) {
    if (a === "-h" || a === "--help") usage(0);
    if (a.startsWith("--session=")) {
      const raw = a.slice("--session=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        process.stderr.write(`huko debug llm-log: invalid --session value: ${raw}\n`);
        usage();
      }
      args.sessionId = n;
      continue;
    }
    if (a.startsWith("--out=")) {
      args.outPath = a.slice("--out=".length);
      continue;
    }
    process.stderr.write(`huko debug llm-log: unexpected argument: ${a}\n`);
    usage();
  }
  return await debugLlmLogCommand(args);
}
