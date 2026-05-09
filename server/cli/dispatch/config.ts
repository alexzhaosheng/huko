/**
 * server/cli/dispatch/config.ts
 *
 * `huko config <verb>` — currently only `show`.
 *
 * Returns exit code; usage() throws CliExitError on bad input.
 */

import { configShowCommand } from "../commands/config.js";
import { usage } from "./shared.js";

export async function dispatchConfig(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === "show" || verb === undefined) {
    return await configShowCommand();
  }
  if (verb === "-h" || verb === "--help") usage(0);
  process.stderr.write(`huko config: unknown verb: ${verb} (try: show)\n`);
  usage();
}
