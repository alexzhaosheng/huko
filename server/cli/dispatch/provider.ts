/**
 * server/cli/dispatch/provider.ts
 *
 * `huko provider <verb>` — argv parser + handoff to commands/provider.
 *
 * --project flag (add / remove): write to <cwd>/.huko/providers.json
 * instead of ~/.huko/providers.json. List always shows the merged view.
 *
 * Returns exit code; usage() throws CliExitError on bad input.
 */

import {
  providerAddCommand,
  providerCurrentCommand,
  providerListCommand,
  providerRemoveCommand,
} from "../commands/provider.js";
import type { OutputFormat } from "../commands/sessions.js";
import { parseFormatFlags, usage } from "./shared.js";

export async function dispatchProvider(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko provider: missing verb (list | add | remove | current)\n"
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
    let protocol: "openai" | "anthropic" | undefined;
    let baseUrl: string | undefined;
    let apiKeyRef: string | undefined;
    let project = false;
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
      else if (arg === "--project") project = true;
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
      ...(project ? { project: true } : {}),
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
    });
  }

  if (verb === "remove") {
    let project = false;
    const positional: string[] = [];
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg === "--project") {
        project = true;
        continue;
      }
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }
    if (positional.length !== 1) {
      process.stderr.write("huko provider remove: expected exactly one <name>\n");
      usage();
    }
    return await providerRemoveCommand({
      name: positional[0]!,
      ...(project ? { project: true } : {}),
    });
  }

  if (verb === "current") {
    let project = false;
    const positional: string[] = [];
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg === "--project") {
        project = true;
        continue;
      }
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }
    if (positional.length === 0) {
      // Read mode — `--project` is meaningless (current is always the
      // merged view). Reject so users don't think it scopes the lookup.
      if (project) {
        process.stderr.write(
          "huko provider current: --project applies only when setting a provider " +
            "(huko provider current <name> --project). Omit it for the read view.\n",
        );
        usage();
      }
      return await providerCurrentCommand({});
    }
    if (positional.length === 1) {
      return await providerCurrentCommand({
        name: positional[0]!,
        ...(project ? { project: true } : {}),
      });
    }
    process.stderr.write("huko provider current: at most one <name>\n");
    usage();
  }

  process.stderr.write(`huko provider: unknown verb: ${verb}\n`);
  usage();
}
