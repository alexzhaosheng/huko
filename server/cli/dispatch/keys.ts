/**
 * server/cli/dispatch/keys.ts
 *
 * `huko keys <verb>` — argv parser + handoff to commands/keys.
 *
 * Verbs: set / unset / list. All have rigid positional shapes — flag
 * parsing is minimal here, mostly typo/help routing.
 */

import {
  keysListCommand,
  keysSetCommand,
  keysUnsetCommand,
} from "../commands/keys.js";
import { usage } from "./shared.js";

export async function dispatchKeys(rest: string[]): Promise<void> {
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
    await keysListCommand();
    return;
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
    await keysSetCommand({ ref: positional[0]!, value: positional[1]! });
    return;
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
    await keysUnsetCommand({ ref: positional[0]! });
    return;
  }

  process.stderr.write(`huko keys: unknown verb: ${verb}\n`);
  usage();
}
