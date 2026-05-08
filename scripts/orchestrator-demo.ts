/**
 * scripts/orchestrator-demo.ts
 *
 * End-to-end smoke test for orchestrator + Persistence + HukoEvent.
 *
 *   1. Build SqlitePersistence (its constructor migrates idempotently)
 *   2. Seed an OpenRouter provider + model + default (idempotent)
 *   3. Build orchestrator with a console-backed HukoEvent emitter
 *   4. Create a chat session
 *   5. Send a user message
 *   6. Watch the typed event stream, await completion, print summary
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx scripts/orchestrator-demo.ts
 *   OPENROUTER_API_KEY=sk-or-... MODEL=openai/gpt-4o-mini npx tsx scripts/orchestrator-demo.ts
 */

import { SqlitePersistence } from "../server/persistence/index.js";
import { TaskOrchestrator } from "../server/services/index.js";
import type { HukoEvent } from "../shared/events.js";
// Temporary: switch to FilePersistence
// import { SqlitePersistence } from "../server/persistence/index.js";
import { FilePersistence } from "../server/persistence/index.js";
// const persistence = new SqlitePersistence();
const persistence = new FilePersistence({ path: "./huko.jsonl" });

// ─── Sanity ──────────────────────────────────────────────────────────────────

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY in your env first.");
  process.exit(1);
}
const modelIdString = process.env["MODEL"] ?? "anthropic/claude-3.5-haiku";

// const persistence = new SqlitePersistence();
// (SqlitePersistence's constructor migrates idempotently if used.)

// ─── Seed: provider + model + default ───────────────────────────────────────

const PROVIDER_NAME = "OpenRouter (demo)";

const allProviders = await persistence.providers.list();
let providerId = allProviders.find((p) => p.name === PROVIDER_NAME)?.id;

if (providerId === undefined) {
  providerId = await persistence.providers.create({
    name: PROVIDER_NAME,
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: { "HTTP-Referer": "https://huko.dev", "X-Title": "Huko" },
  });
} else {
  await persistence.providers.update(providerId, { apiKey });
}

const allModels = await persistence.models.list();
let modelId = allModels.find(
  (m) => m.providerId === providerId && m.modelId === modelIdString,
)?.id;

if (modelId === undefined) {
  modelId = await persistence.models.create({
    providerId,
    modelId: modelIdString,
    displayName: modelIdString,
  });
}

await persistence.config.setDefaultModelId(modelId);

console.log(`seed: provider=${providerId} model=${modelId} (${modelIdString})`);

// ─── Console emitter factory consumes HukoEvent ─────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

let inAssistantStream = false;
const printedToolCallsFor = new Set<number>();

function renderEvent(room: string, event: HukoEvent): void {
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
      if (event.toolCalls && event.toolCalls.length > 0 && !printedToolCallsFor.has(event.entryId)) {
        printedToolCallsFor.add(event.entryId);
        process.stdout.write("\n");
        for (const c of event.toolCalls) {
          console.log(dim(`  -> call ${c.name}(${JSON.stringify(c.arguments)})`));
        }
      }
      break;

    case "tool_result": {
      const tag = `[tool/${event.toolName}]`;
      const colour = event.error ? red : yellow;
      const preview =
        event.content.length > 200 ? event.content.slice(0, 200) + "..." : event.content;
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
      console.log(dim(`\n[${room}] task_terminated status=${event.status}`));
      break;

    case "task_error":
      console.log(red(`\n[${room}] task_error: ${event.error}`));
      break;
  }
}

function makeConsoleEmitter(room: string) {
  return {
    emit(event: HukoEvent) {
      renderEvent(room, event);
    },
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const orchestrator = new TaskOrchestrator({
  persistence,
  emitterFactory: makeConsoleEmitter,
});

const chatSessionId = await orchestrator.createChatSession("demo");
console.log(`chat session: ${chatSessionId}`);

const result = await orchestrator.sendUserMessage({
  chatSessionId,
  content: "Say hi in one short sentence, then tell me a haiku about SQLite.",
});

console.log(`\ntask ${result.taskId} started (interjected=${result.interjected})`);

const summary = await result.completion;

console.log("\n" + dim("-".repeat(60)));
console.log("summary:", summary);
console.log(dim("-".repeat(60)));

persistence.close();
