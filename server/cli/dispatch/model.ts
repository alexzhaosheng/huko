/**
 * server/cli/dispatch/model.ts
 *
 * `huko model <verb>` — argv parser + handoff to commands/model.
 *
 * Verbs: list / add / remove / default.
 * `add` is the heavy one — six flags + `--default` boolean; the
 * dispatcher validates each and forwards to `modelAddCommand`.
 */

import {
  modelAddCommand,
  modelDefaultCommand,
  modelListCommand,
  modelRemoveCommand,
} from "../commands/model.js";
import type { OutputFormat } from "../commands/sessions.js";
import type { ThinkLevel, ToolCallMode } from "../../core/llm/types.js";
import { parseFormatFlags, usage } from "./shared.js";

export async function dispatchModel(rest: string[]): Promise<void> {
  const verb = rest[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stderr.write(
      verb === undefined
        ? "huko model: missing verb (list | add | remove | default)\n"
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
    await modelListCommand({ format });
    return;
  }

  if (verb === "add") {
    let provider: string | undefined;
    let modelId: string | undefined;
    let displayName: string | undefined;
    let thinkLevel: ThinkLevel | undefined;
    let toolCallMode: ToolCallMode | undefined;
    let setDefault = false;
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
      } else if (arg === "--default") {
        setDefault = true;
      } else {
        process.stderr.write(`huko model add: unexpected argument: ${arg}\n`);
        usage();
      }
    }
    if (!provider || !modelId) {
      process.stderr.write("huko model add: --provider and --model-id are required\n");
      usage();
    }
    await modelAddCommand({
      provider: provider!,
      modelId: modelId!,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(thinkLevel !== undefined ? { thinkLevel } : {}),
      ...(toolCallMode !== undefined ? { toolCallMode } : {}),
      ...(setDefault ? { setDefault: true } : {}),
    });
    return;
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
      process.stderr.write("huko model remove: expected exactly one <id>\n");
      usage();
    }
    const id = Number(positional[0]!);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      process.stderr.write(`huko model remove: invalid id: ${positional[0]}\n`);
      usage();
    }
    await modelRemoveCommand({ id });
    return;
  }

  if (verb === "default") {
    const positional: string[] = [];
    for (const arg of rest.slice(1)) {
      if (arg === "-h" || arg === "--help") usage(0);
      if (arg.startsWith("--")) {
        process.stderr.write(`huko: unknown flag: ${arg}\n`);
        usage();
      }
      positional.push(arg);
    }
    if (positional.length === 0) {
      await modelDefaultCommand({});
    } else if (positional.length === 1) {
      const id = Number(positional[0]!);
      if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
        process.stderr.write(`huko model default: invalid id: ${positional[0]}\n`);
        usage();
      }
      await modelDefaultCommand({ id });
    } else {
      process.stderr.write("huko model default: at most one <id>\n");
      usage();
    }
    return;
  }

  process.stderr.write(`huko model: unknown verb: ${verb}\n`);
  usage();
}
