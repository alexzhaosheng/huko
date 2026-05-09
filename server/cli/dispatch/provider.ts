/**
 * server/cli/dispatch/provider.ts
 *
 * `huko provider <verb>` — argv parser + handoff to commands/provider.
 *
 * Returns exit code; usage() throws CliExitError on bad input.
 */

import {
  providerAddCommand,
  providerListCommand,
  providerRemoveCommand,
} from "../commands/provider.js";
import type { OutputFormat } from "../commands/sessions.js";
import type { Protocol } from "../../core/llm/types.js";
import { parseFormatFlags, usage } from "./shared.js";

export async function dispatchProvider(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko provider: missing verb (list | add | remove)\n"
        : "",
    );
    usage(verb === undefined ? 3 : 0);
  }

  if (verb === "list") {
    const { format, positional } = parseFormatFlags<OutputFormat>(
      rest.slice(1),
      ["text", "jsonl", "json"],
      "text",
    );
    if (positional.length > 0) {
      process.stderr.write(
        `huko provider list: unexpected argument: ${positional[0]}\n`,
      );
      usage();
    }
    return await providerListCommand({ format });
  }

  if (verb === "add") {
    let name: string | undefined;
    let protocol: Protocol | undefined;
    let baseUrl: string | undefined;
    let apiKeyRef: string | undefined;
    const headers: Record<string, string> = {};
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
      else if (arg.startsWith("--protocol=")) {
        const v = arg.slice("--protocol=".length);
        if (v !== "openai" && v !== "anthropic") {
          process.stderr.write(`huko provider add: invalid --protocol: ${v}\n`);
          usage();
        }
        protocol = v;
      } else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
      else if (arg.startsWith("--api-key-ref=")) apiKeyRef = arg.slice("--api-key-ref=".length);
      else if (arg.startsWith("--header=")) {
        const kv = arg.slice("--header=".length);
        const eq = kv.indexOf("=");
        if (eq <= 0) {
          process.stderr.write(`huko provider add: invalid --header: ${kv}\n`);
          usage();
        }
        headers[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else {
        process.stderr.write(`huko provider add: unexpected argument: ${arg}\n`);
        usage();
      }
    }
    if (!name || !protocol || !baseUrl || !apiKeyRef) {
      process.stderr.write(
        "huko provider add: --name, --protocol, --base-url, --api-key-ref are required\n",
      );
      usage();
    }
    return await providerAddCommand({
      name: name!,
      protocol: protocol!,
      baseUrl: baseUrl!,
      apiKeyRef: apiKeyRef!,
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
    });
  }

  if (verb === "remove") {
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
      process.stderr.write("huko provider remove: expected exactly one <id|name>\n");
      usage();
    }
    return await providerRemoveCommand({ idOrName: positional[0]! });
  }

  process.stderr.write(`huko provider: unknown verb: ${verb}\n`);
  usage();
}
