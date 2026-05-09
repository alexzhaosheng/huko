/**
 * server/cli/dispatch/keys.ts
 *
 * `huko keys <verb>` — argv parser + handoff to commands/keys.
 *
 * Returns exit code; usage() throws CliExitError on bad input.
 */

import {
  keysListCommand,
  keysSetCommand,
  keysUnsetCommand,
} from "../commands/keys.js";
import { usage } from "./shared.js";

export async function dispatchKeys(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko keys: missing verb (set | unset | list)\n"
        : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "list") {
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      process.stderr.write(`huko keys list: unexpected argument: ${arg}\n`);
      usage();
    }
    return await keysListCommand();
  }

  if (verb === "set") {
    const positional: string[] = [];
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }
    if (positional.length !== 2) {
      process.stderr.write("huko keys set: expected <ref> <value>\n");
      usage();
    }
    return await keysSetCommand({ ref: positional[0]!, value: positional[1]! });
  }

  if (verb === "unset") {
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
      process.stderr.write("huko keys unset: expected <ref>\n");
      usage();
    }
    return await keysUnsetCommand({ ref: positional[0]! });
  }

  process.stderr.write(`huko keys: unknown verb: ${verb}\n`);
  usage();
}
