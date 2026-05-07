/**
 * scripts/engine-demo.ts
 *
 * End-to-end smoke test for the task engine.
 *
 * Boots an in-memory persistence layer, a console-printing emitter,
 * registers one toy server tool (`add`), wires up a SessionContext +
 * TaskContext, and runs a TaskLoop with a real LLM call to OpenRouter.
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
import { EntryKind, type TaskEntryPayload, type TaskEntryUpdatePayload } from "../shared/types.js";

// ─── Sanity checks ───────────────────────────────────────────────────────────

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY in your env first.");
  process.exit(1);
}
const model = process.env["MODEL"] ?? "anthropic/claude-3.5-haiku";

// ─── In-memory storage ───────────────────────────────────────────────────────

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

// ─── Console emitter ─────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

let lastStreamedEntryId: number | null = null;
let lastStreamedLen = 0;
const printedCallsFor = new Set<number>();

const emitter = {
  emit(event: string, data: unknown) {
    if (event === "task:entry") {
      const p = data as TaskEntryPayload;
      const colour =
        p.kind === EntryKind.UserMessage
          ? cyan
          : p.kind === EntryKind.AiMessage
            ? green
            : p.kind === EntryKind.ToolResult
              ? yellow
              : p.kind === EntryKind.SystemReminder
                ? magenta
                : p.kind === EntryKind.StatusNotice
                  ? red
                  : dim;
      const tag = `[${p.kind}/${p.role}]`;
      if (p.kind === EntryKind.AiMessage && p.content === "") {
        // Streaming draft begun — start a fresh line, don't print yet.
        process.stdout.write(`\n${colour(tag)} `);
        lastStreamedEntryId = p.id;
        lastStreamedLen = 0;
        return;
      }
      const preview = p.content.length > 200 ? p.content.slice(0, 200) + "…" : p.content;
      console.log(`\n${colour(tag)} ${preview}`);
    } else if (event === "task:entry_update") {
      const p = data as TaskEntryUpdatePayload;
      // Stream content deltas for the active draft entry.
      if (p.id === lastStreamedEntryId && p.content !== undefined) {
        const newPart = p.content.slice(lastStreamedLen);
        lastStreamedLen = p.content.length;
        if (newPart) process.stdout.write(newPart);
      }
      // Print tool calls when they land (final flush of an assistant turn).
      const meta = p.metadata as Record<string, unknown> | undefined;
      const calls = meta?.["toolCalls"] as
        | Array<{ name: string; arguments: unknown }>
        | undefined;
      if (calls && calls.length > 0 && !printedCallsFor.has(p.id)) {
        printedCallsFor.add(p.id);
        process.stdout.write("\n");
        for (const c of calls) {
          console.log(dim(`  → call ${c.name}(${JSON.stringify(c.arguments)})`));
        }
      }
    }
  },
};

// ─── Register a toy tool ─────────────────────────────────────────────────────

_resetRegistryForTests(); // idempotent — supports re-runs in REPL
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

// ─── Wire it all up ──────────────────────────────────────────────────────────

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
