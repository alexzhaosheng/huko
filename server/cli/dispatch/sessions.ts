/**
 * server/cli/dispatch/sessions.ts
 *
 * `huko sessions <verb>` — argv parser + handoff to commands/sessions.
 *
 * Verbs: list / delete / current / switch / new.
 * Returns the exit code from the underlying command. usage() throws
 * CliExitError on bad input.
 */

import {
  sessionsListCommand,
  sessionsDeleteCommand,
  sessionsCurrentCommand,
  sessionsSwitchCommand,
  sessionsNewCommand,
  type OutputFormat,
} from "../commands/sessions.js";
import { parseFormatFlags, usage as baseUsage } from "./shared.js";
import { renderSessionsHelp } from "./help.js";

function usage(code: number = 3): never {
  return baseUsage(code, renderSessionsHelp);
}

export async function dispatchSessions(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko sessions: missing verb (list | delete | current | switch | new)\n"
        : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "list") {
    const { format, positional } = parseFormatFlags<OutputFormat>(
      rest.slice(1),
      ["text", "jsonl", "json"],
      "text",
      renderSessionsHelp,
    );
    if (positional.length > 0) {
      process.stderr.write(
        `huko sessions list: unexpected argument: ${positional[0]}\n`,
      );
      usage();
    }
    return await sessionsListCommand({ format });
  }

  if (verb === "delete" || verb === "switch") {
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
      process.stderr.write(`huko sessions ${verb}: expected exactly one <id>\n`);
      usage();
    }
    const idRaw = positional[0]!;
    const id = Number(idRaw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      process.stderr.write(`huko sessions ${verb}: invalid id: ${idRaw}\n`);
      usage();
    }
    if (verb === "delete") {
      return await sessionsDeleteCommand({ id });
    }
    return await sessionsSwitchCommand({ id });
  }

  if (verb === "current") {
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      process.stderr.write(`huko sessions current: unexpected argument: ${arg}\n`);
      usage();
    }
    return await sessionsCurrentCommand();
  }

  if (verb === "new") {
    let title: string | undefined;
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--title=")) {
        title = arg.slice("--title=".length);
        continue;
      }
      process.stderr.write(`huko sessions new: unexpected argument: ${arg}\n`);
      usage();
    }
    return await sessionsNewCommand({ ...(title !== undefined ? { title } : {}) });
  }

  process.stderr.write(`huko sessions: unknown verb: ${verb}\n`);
  usage();
}
