/**
 * server/cli/dispatch/config.ts
 *
 * `huko config <verb>` — currently only `show`. Trivial parser kept
 * here for symmetry with the other resources; will gain `get/set/edit`
 * verbs over time.
 */

import { configShowCommand } from "../commands/config.js";
import { usage } from "./shared.js";

export async function dispatchConfig(rest: string[]): Promise<void> {
  const verb = rest[0];
  if (verb === "show" || verb === undefined) {
    await configShowCommand();
    return;
  }
  if (verb === "-h" || verb === "--help") usage(0);
  process.stderr.write(`huko config: unknown verb: ${verb} (try: show)\n`);
  usage();
}
