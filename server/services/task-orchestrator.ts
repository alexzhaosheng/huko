/**
 * server/services/task-orchestrator.ts
 *
 * Glue layer between HTTP/WS transport and the engine.
 *
 * The orchestrator is the seam where infrastructure (DB, emitter) meets
 * the engine (SessionContext, TaskContext, TaskLoop). It does NOT speak
 * HTTP or Socket.IO directly — those are abstracted away as injected
 * factories so the engine layer stays pure and the orchestrator stays
 * testable with stubs.
 *
 * Responsibilities:
 *   - Cache live SessionContexts by (type, id) — sessions outlive tasks
 *   - Track running TaskLoops for stop/interject routing
 *   - Wire DI seams (PersistFn, UpdateFn, Emitter) at task spinup
 *   - Resolve model config via `models` ⨝ `providers` lookup
 *   - Manage task lifecycle (create → run → finalize → cleanup)
 *
 * Out of scope:
 *   - Auth / users (huko is single-user)
 *   - Resume / orphan recovery (separate flow; see resume.ts)
 *   - Routing decisions ABOVE the engine (those live in tRPC routers)
 */

// Side-effect: register all built-in tools so getToolsForLLM() works.
import "../task/tools/index.js";

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  chatSessions,
  tasks,
  providers,
  models,
  appConfig,
} from "../db/schema.js";
import {
  makePersistEntry,
  makeUpdateEntry,
  loadSessionLLMContext,
} from "../db/adapter.js";
import { SessionContext, type Emitter } from "../engine/SessionContext.js";
import { TaskContext } from "../engine/TaskContext.js";
import { TaskLoop, type TaskRunSummary } from "../task/task-loop.js";
import { getToolsForLLM } from "../task/tools/registry.js";
import {
  EntryKind,
  type SessionType,
  type TaskStatus,
  type UserAttachment,
} from "../../shared/types.js";
import type {
  Protocol,
  ThinkLevel,
  ToolCallMode,
} from "../core/llm/types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Build an Emitter for the given room id (e.g. "chat:42"). */
export type EmitterFactory = (room: string) => Emitter;

export type OrchestratorOptions = {
  db: Db;
  emitterFactory: EmitterFactory;
  /** Default system prompt for chats with no override. */
  defaultSystemPrompt?: string;
};

export type SendMessageInput = {
  chatSessionId: number;
  content: string;
  attachments?: UserAttachment[];
  /** Optional override; defaults to app_config.default_model_id. */
  modelId?: number;
};

export type SendMessageResult = {
  taskId: number;
  /** True if this message interjected an in-flight task; false for new tasks. */
  interjected: boolean;
  /** Resolves when the relevant task reaches a terminal state. */
  completion: Promise<TaskRunSummary>;
};

// ─── Default system prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT =
  "You are huko, a helpful assistant. Be concise and accurate. Use tools when available rather than guessing.";

// ─── TaskOrchestrator ─────────────────────────────────────────────────────────

export class TaskOrchestrator {
  private readonly db: Db;
  private readonly emitterFactory: EmitterFactory;
  private readonly defaultSystemPrompt: string;

  /** Cached SessionContexts keyed by `${sessionType}:${sessionId}`. */
  private readonly liveSessions = new Map<string, SessionContext>();
  /** Emitters tracked alongside SessionContexts for terminal-event push. */
  private readonly liveSessionEmitters = new Map<string, Emitter>();
  /** Live TaskLoops keyed by taskId. */
  private readonly liveLoops = new Map<number, TaskLoop>();
  /** Reverse index: sessionKey → taskId of the in-flight loop, if any. */
  private readonly sessionToLoop = new Map<string, number>();
  /** Per-task completion promises. Cleared after `awaitTask` reads them. */
  private readonly taskCompletions = new Map<number, Promise<TaskRunSummary>>();

  constructor(opts: OrchestratorOptions) {
    this.db = opts.db;
    this.emitterFactory = opts.emitterFactory;
    this.defaultSystemPrompt = opts.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  // ─── Public entry points ───────────────────────────────────────────────────

  async createChatSession(title: string = ""): Promise<number> {
    const row = await this.db
      .insert(chatSessions)
      .values({ title })
      .returning({ id: chatSessions.id })
      .get();
    return row.id;
  }

  /**
   * Process a user message.
   *
   *   - If there's a live task on the session: append the message and
   *     interject the current LLM call. The task continues with the new
   *     message in context.
   *   - Otherwise: create a new task and start a TaskLoop.
   */
  async sendUserMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const sessionKey = sessionKeyOf("chat", input.chatSessionId);
    const sessionContext = await this.getOrCreateSessionContext(
      "chat",
      input.chatSessionId,
    );

    const liveTaskId = this.sessionToLoop.get(sessionKey);
    if (liveTaskId !== undefined) {
      const loop = this.liveLoops.get(liveTaskId);
      if (loop) {
        // Append BEFORE interjecting — the loop expects the new message
        // to already be in context when it resumes the next iteration.
        await sessionContext.append({
          taskId: liveTaskId,
          kind: EntryKind.UserMessage,
          role: "user",
          content: input.content,
          ...(input.attachments?.length
            ? { metadata: { attachments: input.attachments } }
            : {}),
        });
        loop.interject();
        const completion =
          this.taskCompletions.get(liveTaskId) ?? Promise.reject(new Error("missing"));
        return { taskId: liveTaskId, interjected: true, completion };
      }
      // Stale entry — clean up and proceed with a new task.
      this.sessionToLoop.delete(sessionKey);
    }

    return this.startNewTask("chat", input.chatSessionId, sessionContext, input);
  }

  /** Hard-stop a running task. Returns true if the task was actually live. */
  stop(taskId: number): boolean {
    const loop = this.liveLoops.get(taskId);
    if (!loop) return false;
    loop.stop();
    return true;
  }

  /**
   * Wait for a task to finish. If it has already finished, the saved
   * promise is still cached (until cleared) — otherwise we read the row
   * from DB and synthesise a summary.
   */
  async awaitTask(taskId: number): Promise<TaskRunSummary> {
    const cached = this.taskCompletions.get(taskId);
    if (cached) return cached;

    const row = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!row) throw new Error(`Task ${taskId} not found.`);

    return summaryFromRow(row);
  }

  // ─── Internals: task lifecycle ─────────────────────────────────────────────

  private async startNewTask(
    sessionType: SessionType,
    sessionId: number,
    sessionContext: SessionContext,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const config = await this.resolveModelConfig(input.modelId);

    // Insert task FIRST — every task_context entry needs a taskId FK.
    const taskRow = await this.db
      .insert(tasks)
      .values({
        chatSessionId: sessionType === "chat" ? sessionId : null,
        agentSessionId: sessionType === "agent" ? sessionId : null,
        status: "running",
        modelId: config.modelId,
        toolCallMode: config.toolCallMode,
        thinkLevel: config.thinkLevel,
      })
      .returning({ id: tasks.id })
      .get();
    const taskId = taskRow.id;

    // Append the user message AS PART OF THIS TASK.
    await sessionContext.append({
      taskId,
      kind: EntryKind.UserMessage,
      role: "user",
      content: input.content,
      ...(input.attachments?.length
        ? { metadata: { attachments: input.attachments } }
        : {}),
    });

    // Build TaskContext and TaskLoop.
    const sessionOwnership =
      sessionType === "chat"
        ? ({ sessionType: "chat", chatSessionId: sessionId } as const)
        : ({ sessionType: "agent", agentSessionId: sessionId } as const);

    const taskContext = new TaskContext({
      taskId,
      ...sessionOwnership,
      protocol: config.protocol,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      toolCallMode: config.toolCallMode,
      thinkLevel: config.thinkLevel,
      ...(config.defaultHeaders ? { headers: config.defaultHeaders } : {}),
      tools: getToolsForLLM(),
      systemPrompt: this.defaultSystemPrompt,
      sessionContext,
    });

    const loop = new TaskLoop(taskContext);
    const sessionKey = sessionKeyOf(sessionType, sessionId);
    this.liveLoops.set(taskId, loop);
    this.sessionToLoop.set(sessionKey, taskId);

    // Wrap loop.run() so handlers run before the promise settles, and
    // the awaitable surfaces the same summary to external callers.
    const completion = loop.run().then(
      async (summary) => {
        await this.handleTaskDone(taskId, sessionKey, summary);
        return summary;
      },
      async (err) => {
        await this.handleTaskCrash(taskId, sessionKey, err);
        throw err;
      },
    );
    this.taskCompletions.set(taskId, completion);

    return { taskId, interjected: false, completion };
  }

  private async handleTaskDone(
    taskId: number,
    sessionKey: string,
    summary: TaskRunSummary,
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: summary.status,
        finalResult: summary.finalResult,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        toolCallCount: summary.toolCallCount,
        iterationCount: summary.iterationCount,
        updatedAt: Date.now(),
      })
      .where(eq(tasks.id, taskId))
      .run();

    this.cleanupTask(taskId, sessionKey);

    const emitter = this.liveSessionEmitters.get(sessionKey);
    emitter?.emit(`task:${summary.status}`, { taskId, summary });
  }

  private async handleTaskCrash(
    taskId: number,
    sessionKey: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.db
      .update(tasks)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: Date.now(),
      })
      .where(eq(tasks.id, taskId))
      .run();

    this.cleanupTask(taskId, sessionKey);

    const emitter = this.liveSessionEmitters.get(sessionKey);
    emitter?.emit("task:error", { taskId, error: message });
  }

  private cleanupTask(taskId: number, sessionKey: string): void {
    this.liveLoops.delete(taskId);
    if (this.sessionToLoop.get(sessionKey) === taskId) {
      this.sessionToLoop.delete(sessionKey);
    }
    // Keep `taskCompletions` so a late `awaitTask()` still resolves.
    // Cleared on next process restart; lightweight enough for single-user.
  }

  // ─── Internals: session context lookup ────────────────────────────────────

  private async getOrCreateSessionContext(
    sessionType: SessionType,
    sessionId: number,
  ): Promise<SessionContext> {
    const key = sessionKeyOf(sessionType, sessionId);
    const cached = this.liveSessions.get(key);
    if (cached) return cached;

    const emitter = this.emitterFactory(key);
    const initialContext = await loadSessionLLMContext(
      this.db,
      sessionId,
      sessionType,
    );

    const sc = new SessionContext({
      sessionId,
      sessionType,
      persist: makePersistEntry(this.db),
      updateDb: makeUpdateEntry(this.db),
      emitter,
      initialContext,
    });

    this.liveSessions.set(key, sc);
    this.liveSessionEmitters.set(key, emitter);
    return sc;
  }

  // ─── Internals: model config ──────────────────────────────────────────────

  private async resolveModelConfig(
    modelId?: number,
  ): Promise<ResolvedModelConfig> {
    let id = modelId;
    if (id == null) {
      const cfg = await this.db
        .select()
        .from(appConfig)
        .where(eq(appConfig.key, "default_model_id"))
        .get();
      const v = cfg?.value;
      if (typeof v !== "number") {
        throw new Error(
          "No default model configured. Set app_config.default_model_id (number).",
        );
      }
      id = v;
    }

    const row = await this.db
      .select({
        modelId: models.modelId,
        defaultThinkLevel: models.defaultThinkLevel,
        defaultToolCallMode: models.defaultToolCallMode,
        protocol: providers.protocol,
        baseUrl: providers.baseUrl,
        apiKey: providers.apiKey,
        defaultHeaders: providers.defaultHeaders,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(eq(models.id, id))
      .get();

    if (!row) throw new Error(`Model id=${id} not found.`);

    return {
      modelId: row.modelId,
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      toolCallMode: row.defaultToolCallMode,
      thinkLevel: row.defaultThinkLevel,
      defaultHeaders: row.defaultHeaders ?? null,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionKeyOf(type: SessionType, id: number): string {
  return `${type}:${id}`;
}

function summaryFromRow(row: typeof tasks.$inferSelect): TaskRunSummary {
  const status: TaskStatus = ["done", "failed", "stopped"].includes(row.status)
    ? row.status
    : "failed"; // anything non-terminal at read time → treat as failed
  return {
    status,
    finalResult: row.finalResult,
    hasExplicitResult: row.finalResult.length > 0,
    toolCallCount: row.toolCallCount,
    iterationCount: row.iterationCount,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    elapsedMs: 0, // not tracked in DB at task-end resolution; fine for resumed lookups
  };
}

// ─── Internal types ───────────────────────────────────────────────────────────

type ResolvedModelConfig = {
  modelId: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  defaultHeaders: Record<string, string> | null;
};
