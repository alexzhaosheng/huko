/**
 * server/cli/formatters/index.ts
 *
 * Factory + barrel. The CLI's run command picks a formatter by name.
 */

import type { FormatName, Formatter } from "./types.js";
import { makeTextFormatter } from "./text.js";
import { makeJsonlFormatter } from "./jsonl.js";
import { makeJsonFormatter } from "./json.js";

export type { Formatter, FormatName } from "./types.js";

export type FormatterOptions = {
  /** Show tool_result previews + full system_reminder bodies. Default false. */
  verbose?: boolean;
};

export function makeFormatter(name: FormatName, opts: FormatterOptions = {}): Formatter {
  switch (name) {
    case "text":
      return makeTextFormatter({ verbose: opts.verbose ?? false });
    case "jsonl":
      return makeJsonlFormatter();
    case "json":
      return makeJsonFormatter();
  }
}
