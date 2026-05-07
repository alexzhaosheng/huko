/**
 * scripts/orchestrator-demo.ts
 *
 * End-to-end smoke test for the orchestrator + DB layer.
 *
 *   1. Run migrations (idempotent)
 *   2. Seed provider + model + default_model_id
 *   3. Build orchestrator with a console emitter factory
 *   4. Create a chat session
 *   5. Send a user message
 *   6. Watch streamed output, await completion, print summary
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx scripts/orchestrator-demo.ts
 *   OPENROUTER_API_KEY=sk-or-... MODEL=openai/gpt-4o-mini npx tsx scripts/orchestrator-demo.ts
 *   HUKO_DB_PATH=/tmp/huko-demo.db OPENROUTER_API_KEY=... npx tsx scripts/orchestrator-demo.ts
 */

import { and, eq } from "drizzle-orm";
import { runMigrations } from "../server/db/migrate.js";
import { db, sqlite } from "../server/db/client.js";
import { providers, models, appConfig, chatSessions } from "../server/db/schema.js";
import { TaskOrchestrator } from "../server/services/index.js";
import {
  EntryKind,
  type TaskEntryPayload,
  type TaskEntryUpdatePayload,
} from "../shared/types.js";

// ─── Sanity ──────────────────────────────────────────────────────────────────

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY in your env first.");
  process.exit(1);
}
const modelIdString = process.env["MODEL"] ?? "anthropic/claude-3.5-haiku";

// ─── Migrate ─────────────────────────────────────────────────────────────────

const migration = runMigrations();
if (migration.applied.length > 0) {
  console.log(`migrated: applied ${migration.applied.length}, skipped ${migration.skipped.length}`);
}

// ─── Seed ────────────────────────────────────────────────────────────────────

let provider = db
  .select()
  .from(providers)
  .where(eq(providers.name, "OpenRouter (demo)"))
  .get();
if (!provider) {
  const inserted = db
    .insert(providers)
    .values({
      name: "OpenRouter (demo)",
      protocol: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: { "HTTP-Referer": "https://huko.dev", "X-Title": "Huko" },
    })
    .returning({ id: providers.id })
    .get();
  provider = db.select().from(providers).where(eq(providers.id, inserted.id)).get()!;
} else if (provider.apiKey !== apiKey) {
  // Refresh the key in case the env changed.
  db.update(providers).set({ apiKey }).where(eq(providers.id, provider.id)).run();
}

let model = db
  .select()
  .from(models)
  .where(and(eq(models.providerId, provider.id), eq(models.modelId, modelIdString)))
  .get();
if (!model) {
  const inserted = db
    .insert(models)
    .values({
      providerId: provider.id,
      modelId: modelIdString,
      displayName: modelIdString,
    })
    .returning({ id: models.id })
    .get();
  model = db.select().from(models).where(eq(models.id, inserted.id)).get()!;
}

// Set default_model_id (upsert).
const existingDefault = db
  .select()
  .from(appConfig)
  .where(eq(appConfig.key, "default_model_id"))
  .get();
if (existingDefault) {
  db.update(appConfig)
    .set({ value: model.id, updatedAt: Date.now() })
    .where(eq(appConfig.key, "default_model_id"))
    .run();
} else {
  db.insert(appConfig).values({ key: "default_model_id", value: model.id }).run();
}

console.log(`seed: provider=${provider.id} model=${model.id} (${model.modelId})`);

// ─── Console emitter factory ─────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

let lastStreamedEntryId: number | null = null;
let lastStreamedLen = 0;
const printedCallsFor = new Set<number>();

function makeConsoleEmitter(room: string) {
  return {
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
          process.stdout.write(`\n${colour(tag)} `);
          lastStreamedEntryId = p.id;
          lastStreamedLen = 0;
          return;
        }
        const preview = p.content.length > 200 ? p.content.slice(0, 200) + "..." : p.content;
        console.log(`\n${colour(tag)} ${preview}`);
      } else if (event === "task:entry_update") {
        const p = data as TaskEntryUpdatePayload;
        if (p.id === lastStreamedEntryId && p.content !== undefined) {
          const newPart = p.content.slice(lastStreamedLen);
          lastStreamedLen = p.content.length;
          if (newPart) process.stdout.write(newPart);
        }
        const meta = p.metadata as Record<string, unknown> | undefined;
        const calls = meta?.["toolCalls"] as
          | Array<{ name: string; arguments: unknown }>
          | undefined;
        if (calls && calls.length > 0 && !printedCallsFor.has(p.id)) {
          printedCallsFor.add(p.id);
          process.stdout.write("\n");
          for (const c of calls) {
            console.log(dim(`  -> call ${c.name}(${JSON.stringify(c.arguments)})`));
          }
        }
      } else if (
        event === "task:done" ||
        event === "task:failed" ||
        event === "task:stopped" ||
        event === "task:error"
      ) {
        console.log(dim(`\n[${room}] ${event}`));
      }
    },
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const orchestrator = new TaskOrchestrator({
  db,
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

console.log("\n" + dim("─".repeat(60)));
console.log("summary:", summary);
console.log(dim("─".repeat(60)));

// Clean shutdown so WAL flushes.
sqlite.close();
