/**
 * server/cli/dispatch/info.ts
 *
 * `huko info [scope]` — argv parser + handoff to commands/info.
 *
 * Optional positional: `global` | `project`. Defaults to the merged
 * view. `--format=text|json|jsonl` (or shortcuts) supported.
 *
 * Note: there's no `builtin` scope. `huko info` (merged) already labels
 * pointers from the builtin layer via the source column; if you want to
 * see exactly what huko ships with, run `huko provider list` /
 * `huko model list` and look for the `builtin` source.
 */

import { infoCommand, type InfoScope, type OutputFormat } from "../commands/info.js";
import { parseFormatFlags, usage } from "./shared.js";

const SCOPES = ["global", "project"] as const;

export async function dispatchInfo(rest: string[]): Promise<number> {
  const { format, positional } = parseFormatFlags<OutputFormat>(
    rest,
    ["text", "jsonl", "json"],
    "text",
  );

  let scope: InfoScope = "all";
  if (positional.length === 1) {
    const arg = positional[0]!;
    if (arg === "-h" || arg === "--help") usage(0);
    if (!(SCOPES as readonly string[]).includes(arg)) {
      process.stderr.write(
        `huko info: invalid scope "${arg}" (allowed: ${SCOPES.join(" | ")} or omit for merged view)\n`,
      );
      usage();
    }
    scope = arg as InfoScope;
  } else if (positional.length > 1) {
    process.stderr.write(`huko info: at most one scope argument\n`);
    usage();
  }

  return await infoCommand({ scope, format });
}
