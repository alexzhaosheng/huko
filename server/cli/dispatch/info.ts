/**
 * server/cli/dispatch/info.ts
 *
 * `huko info [scope]` — argv parser + handoff to commands/info.
 *
 * Optional positional: `global` | `project` | `builtin`. Defaults to
 * the merged view. `--format=text|json|jsonl` (or shortcuts) supported.
 */

import { infoCommand, type InfoScope, type OutputFormat } from "../commands/info.js";
import { parseFormatFlags, usage } from "./shared.js";

const SCOPES = ["global", "project", "builtin"] as const;

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
