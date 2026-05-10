/**
 * server/cli/dispatch/model.ts
 *
 * `huko model <verb>` — argv parser + handoff to commands/model.
 *
 * Models are identified by composite ref `<providerName>/<modelId>`,
 * e.g. `anthropic/claude-sonnet-4-6` or `openrouter/anthropic/claude-sonnet-4.5`.
 * The first `/` separates provider from modelId; everything after is
 * the modelId (so OpenRouter slugs containing `/` work).
 *
 * --project (add / remove / default): operate on <cwd>/.huko/providers.json
 * instead of ~/.huko/providers.json.
 */

import {
  modelAddCommand,
  modelCurrentCommand,
  modelListCommand,
  modelRemoveCommand,
} from "../commands/model.js";
import type { OutputFormat } from "../commands/sessions.js";
import type { ThinkLevel, ToolCallMode } from "../../core/llm/types.js";
import { parseFormatFlags, usage } from "./shared.js";

export async function dispatchModel(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko model: missing verb (list | add | remove | current)\n"
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
      process.stderr.write(`huko model list: unexpected argument: ${positional[0]}\n`);
      usage();
    }
    return await modelListCommand({ format });
  }

  if (verb === "add") {
    let provider: string | undefined;
    let modelId: string | undefined;
    let displayName: string | undefined;
    let thinkLevel: ThinkLevel | undefined;
    let toolCallMode: ToolCallMode | undefined;
    let setCurrent = false;
    let project = false;
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--provider=")) provider = arg.slice("--provider=".length);
      else if (arg.startsWith("--model-id=")) modelId = arg.slice("--model-id=".length);
      else if (arg.startsWith("--display-name=")) displayName = arg.slice("--display-name=".length);
      else if (arg.startsWith("--think-level=")) {
        const v = arg.slice("--think-level=".length);
        if (v !== "off" && v !== "low" && v !== "medium" && v !== "high") {
          process.stderr.write(`huko model add: invalid --think-level: ${v}\n`);
          usage();
        }
        thinkLevel = v;
      } else if (arg.startsWith("--tool-call-mode=")) {
        const v = arg.slice("--tool-call-mode=".length);
        if (v !== "native" && v !== "xml") {
          process.stderr.write(`huko model add: invalid --tool-call-mode: ${v}\n`);
          usage();
        }
        toolCallMode = v;
      } else if (arg === "--current") {
        setCurrent = true;
      } else if (arg === "--project") {
        project = true;
      } else {
        process.stderr.write(`huko model add: unexpected argument: ${arg}\n`);
        usage();
      }
    }
    if (!provider || !modelId) {
      process.stderr.write("huko model add: --provider and --model-id are required\n");
      usage();
    }
    return await modelAddCommand({
      provider: provider!,
      modelId: modelId!,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(thinkLevel !== undefined ? { thinkLevel } : {}),
      ...(toolCallMode !== undefined ? { toolCallMode } : {}),
      ...(setCurrent ? { setCurrent: true } : {}),
      ...(project ? { project: true } : {}),
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
      process.stderr.write("huko model remove: expected exactly one <ref>\n");
      usage();
    }
    return await modelRemoveCommand({
      ref: positional[0]!,
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
      return await modelCurrentCommand({});
    }
    if (positional.length === 1) {
      return await modelCurrentCommand({
        modelId: positional[0]!,
        ...(project ? { project: true } : {}),
      });
    }
    process.stderr.write("huko model current: at most one <modelId>\n");
    usage();
  }

  process.stderr.write(`huko model: unknown verb: ${verb}\n`);
  usage();
}
