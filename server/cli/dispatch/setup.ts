/**
 * server/cli/dispatch/setup.ts
 *
 * `huko setup` — interactive wizard. Takes no flags or verbs (yet);
 * any extra args are usage errors. Help just prints the high-level
 * intent and points at the wizard itself for the actual prompts.
 */

import { setupCommand } from "../commands/setup.js";
import { usage } from "./shared.js";

export async function dispatchSetup(rest: string[]): Promise<number> {
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") {
      process.stderr.write(
        "huko setup — interactive wizard\n" +
          "  Walks you through: scope → provider → key ref → key handling\n" +
          "  → default model. Press Ctrl+C to abort at any prompt.\n",
      );
      return 0;
    }
    process.stderr.write(`huko setup: unexpected argument: ${arg}\n`);
    usage();
  }
  return await setupCommand();
}
