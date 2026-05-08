/**
 * scripts/engine-demo.ts
 *
 * End-to-end smoke test for the engine — bypasses the daemon stack.
 *
 * Boots an in-memory persistence layer (just two function stubs that
 * SessionContext needs), a console emitter consuming HukoEvent, registers
 * one toy server tool (`add`), wires up a SessionContext + TaskContext,
 * and runs a TaskLoop with a real LLM call to OpenRouter.
 *
 * If you see:
 *   - streamed assistant tokens (gray when thinking, white when reply)
 *   - one or more tool_call cards
 *   - one or more tool_result cards
 *   - a final assistant message
 *   - a summary block at the end
 * ...then the engine is breathing end-to-end.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx scripts/engine-demo.ts
 *   OPENROUTER_API_KEY=sk-or-... MODEL=openai/gpt-4o-mini npx tsx scripts/engine-demo.ts
 */

import { openrouter } from "../server/core/llm/index.js";
import { SessionContext } from "../server/engine/SessionContext.js";
import { TaskContext } from "../server/engine/TaskContext.js";
import { TaskLoop } from "../server/task/task-loop.js";
import {
  registerServerTool,
  _resetRegistryForTests,
} from "../server/task/tools/registry.js";
import { EntryKind } from "../shared/types.js";
import type { HukoEvent } from "../shared/events.js";

// ─── Sanity ──────────────────────────────────────────────────────────────────

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY in your env first.");
  process.exit(1);
}
const model = process.env["MODEL"] ?? "anthropic/claude-3.5-haiku";

// ─── In-memory persist / update stubs (just enough for SessionContext) ──────

type StoredEntry = {
  id: number;
  taskId: number;
  sessionId: number;
  sessionType: "chat" | "agent";
  kind: string;
  role: string;
  content: string;
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
};

const entries: StoredEntry[] = [];
let nextId = 1;

const persist = async (e: Omit<StoredEntry, "id" | "createdAt">): Promise<number> => {
  const id = nextId++;
  entries.push({ ...e, id, createdAt: new Date() });
  return id;
};

const updateDb = async (
  entryId: number,
  patch: { content?: string; metadata?: Record<string, unknown>; mergeMetadata?: boolean },
): Promise<void> => {
  const e = entries.find((x) => x.id === entryId);
  if (!e) return;
  if (patch.content !== undefined) e.content = patch.content;
  if (patch.metadata !== undefined) {
    e.metadata = patch.mergeMetadata ? { ...(e.metadata ?? {}), ...patch.metadata } : patch.metadata;
  }
};

// ─── Console emitter consumes HukoEvent ─────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

let inAssistantStream = false;
const printedCallsFor = new Set<number>();

const emitter = {
  emit(event: HukoEvent): void {
    switch (event.type) {
      case "user_message":
        console.log(`\n${cyan("[you]")} ${event.content}`);
        break;
      case "assistant_started":
        process.stdout.write(`\n${green("[huko]")} `);
        inAssistantStream = true;
        break;
      case "assistant_content_delta":
        if (inAssistantStream) process.stdout.write(event.delta);
        break;
      case "assistant_thinking_delta":
        if (inAssistantStream) process.stdout.write(dim(event.delta));
        break;
      case "assistant_complete":
        inAssistantStream = false;
        if (event.toolCalls && event.toolCalls.length > 0 && !printedCallsFor.has(event.entryId)) {
          printedCallsFor.add(event.entryId);
          process.stdout.write("\n");
          for (const c of event.toolCalls) {
            console.log(dim(`  → call ${c.name}(${JSON.stringify(c.arguments)})`));
          }
        }
        break;
      case "tool_result": {
        const tag = `[tool/${event.toolName}]`;
        const colour = event.error ? red : yellow;
        const preview = event.content.length > 200 ? event.content.slice(0, 200) + "…" : event.content;
        console.log(`\n${colour(tag)} ${event.error ? `error: ${event.error}` : preview}`);
        break;
      }
      case "system_reminder":
        console.log(`\n${magenta("[reminder]")} ${event.content}`);
        break;
      case "system_notice":
        console.log(`\n${red("[notice/" + event.severity + "]")} ${event.content}`);
        break;
      case "task_terminated":
        console.log(dim(`\n[task] terminated status=${event.status}`));
        break;
      case "task_error":
        console.log(red(`\n[task] error: ${event.error}`));
        break;
    }
  },
};

// ─── Register a toy tool ─────────────────────────────────────────────────────

_resetRegistryForTests();
registerServerTool(
  {
    name: "add",
    description: "Add two numbers and return the sum as a decimal string.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First addend." },
        b: { type: "number", description: "Second addend." },
      },
      required: ["a", "b"],
    },
  },
  (args) => {
    const a = Number(args["a"]);
    const b = Number(args["b"]);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      return { result: "", error: "Both arguments must be numbers." };
    }
    return String(a + b);
  },
);

// ─── Wire up the engine ──────────────────────────────────────────────────────

const sessionContext = new SessionContext({
  sessionId: 1,
  sessionType: "chat",
  persist,
  updateDb,
  emitter,
});

await sessionContext.append({
  taskId: 1,
  kind: EntryKind.UserMessage,
  role: "user",
  content: "Use the add tool to compute 17 + 29, then state the answer plainly.",
});

const taskContext = new TaskContext({
  taskId: 1,
  sessionType: "chat",
  chatSessionId: 1,
  protocol: openrouter.protocol,
  modelId: model,
  baseUrl: openrouter.baseUrl,
  apiKey,
  toolCallMode: "native",
  thinkLevel: "off",
  headers: openrouter.defaultHeaders ?? {},
  tools: [
    {
      name: "add",
      description: "Add two numbers and return the sum as a decimal string.",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number", description: "First addend." },
          b: { type: "number", description: "Second addend." },
        },
        required: ["a", "b"],
      },
    },
  ],
  systemPrompt:
    "You are a careful arithmetic assistant. When a calculation is needed, call the `add` tool — do not compute it yourself. After the tool returns, state the answer in one short sentence.",
  sessionContext,
});

const loop = new TaskLoop(taskContext);
const summary = await loop.run();

console.log("\n");
console.log(dim("─".repeat(60)));
console.log("summary:");
console.log(summary);
console.log(dim("─".repeat(60)));
console.log("final result:");
console.log(taskContext.finalResult);
