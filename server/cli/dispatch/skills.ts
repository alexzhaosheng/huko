/**
 * server/cli/dispatch/skills.ts
 *
 * `huko skills <verb>` — only verb today is `list`. Kept minimal so
 * future verbs (`enable`, `disable`, `show`) can slot in without a
 * refactor.
 */

import { skillsListCommand } from "../commands/skills.js";
import { usage } from "./shared.js";

export async function dispatchSkills(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined ? "huko skills: missing verb (list)\n" : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "list") {
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      process.stderr.write(`huko skills list: unexpected argument: ${arg}\n`);
      usage();
    }
    return await skillsListCommand({ format: "text" });
  }

  process.stderr.write(`huko skills: unknown verb: ${verb}\n`);
  usage();
}
