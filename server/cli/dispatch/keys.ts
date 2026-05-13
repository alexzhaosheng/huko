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
    // Argv form:
    //   set <ref>                         → prompt hidden for value
    //   set <ref> --value <secret>        → inline (scripting; discouraged)
    //
    // We deliberately do NOT accept the old `set <ref> <value>` form: it
    // leaks the secret to shell history, /proc/<pid>/cmdline, and any
    // audit-logging tooling on the box. Same threat model as `vault add`,
    // which already enforces this — `keys set` now matches.
    let ref: string | undefined;
    let inlineValue: string | undefined;
    const args = rest.slice(1);
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "-h" || a === "--help") usage(0);
      if (a === "--value") {
        const next = args[i + 1];
        if (next === undefined) {
          process.stderr.write("huko keys set: --value requires a value\n");
          usage();
        }
        inlineValue = next;
        i += 2;
        continue;
      }
      if (a.startsWith("--value=")) {
        inlineValue = a.slice("--value=".length);
        i++;
        continue;
      }
      if (a.startsWith("-")) {
        process.stderr.write(`huko keys set: unknown flag: ${a}\n`);
        usage();
      }
      if (ref === undefined) {
        ref = a;
        i++;
        continue;
      }
      process.stderr.write(
        `huko keys set: unexpected positional argument: ${a}\n` +
          "  (the value is no longer a positional — it leaks to shell history.\n" +
          "   either omit it for a hidden prompt, or pass --value <secret> for scripting.)\n",
      );
      usage();
    }
    if (ref === undefined) {
      process.stderr.write(
        "huko keys set: missing <ref>\n" +
          "         usage: huko keys set <ref> [--value <secret>]\n" +
          "         (without --value, you'll be prompted for the secret with hidden input)\n",
      );
      usage();
    }
    return await keysSetCommand({
      ref,
      ...(inlineValue !== undefined ? { inlineValue } : {}),
    });
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
