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

export function makeFormatter(name: FormatName): Formatter {
  switch (name) {
    case "text":
      return makeTextFormatter();
    case "jsonl":
      return makeJsonlFormatter();
    case "json":
      return makeJsonFormatter();
  }
}
