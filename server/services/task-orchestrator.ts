/**
 * server/services/task-orchestrator.ts
 *
 * Glue layer between transport (HTTP/WS, CLI) and the engine.
 *
 * The orchestrator speaks three interfaces:
 *
 *   - `InfraPersistence` for user-global state (providers, models,
 *     system-level default model). One instance shared across every
 *     project on the machine.
 *
 *   - `SessionPersistence` for per-project state (chat sessions, tasks,
 *     entry log). One instance per `<cwd>/.huko/huko.db`.
 *
 *   - `EmitterFactory` for outgoing `HukoEvent`s. The factory hands back
 *     an Emitter for a given room id; the orchestrator never knows
 *     whether it's Socket.IO, an in-memory collector, or stdout.
 *
 * Out of scope:
 *   - Auth / users (huko is single-user)
 *   - Resume / orphan recovery (separate flow)
 *   - Routing decisions ABOVE the engine (those live in tRPC routers / CLI)
 */

// Side-effect: register all built-in tools so getToolsForLLM() works.
import "../task/tools/index.js";

import { SessionContext, type Emitter } from "../engine/SessionContext.js";
import { TaskContext } from "../engine/TaskContext.js";
import { TaskLoop, type TaskRunSummary } from "../task/task-loop.js";
import { getToolsForLLM, type ToolFilterContext } from "../task/tools/registry.js";
import {
  EntryKind,
  type SessionType,
  type TaskStatus,
  type UserAttachment,
} from "../../shared/types.js";
import type {
  InfraPersistence,
  ResolvedModelConfig,
  SessionPersistence,
  TaskRow,
} from "../persistence/index.js";
import type { TaskSummary } from "../../shared/events.js";
import { loadRole } from "../roles/index.js";
import { getConfig } from "../config/index.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { recoverOrphans, type RecoveryReport } from "../task/resume.js";
import { estimateContextWindow } from "../core/llm/model-context-window.js";
import { resolveApiKey } from "../security/keys.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Build an Emitter for the given room id (e.g. "chat:42"). */
export type EmitterFactory = (room: string) => Emitter;

export type OrchestratorOptions = {
  /**
   * User-global infra DB: providers, models, system defaults like
   * default_model_id. Same instance shared across all projects.
   */
  infra: InfraPersistence;
  /**
   * Per-project session DB: this project's chat sessions, tasks, and
   * the LLM-visible entry log.
   */
  session: SessionPersistence;
  emitterFactory: EmitterFactory;
};

export type SendMessageInput = {
  chatSessionId: number;
  content: string;
  attachments?: UserAttachment[];
  modelId?: number;
  /** Role name (loaded from server/roles/ etc.). Defaults to `coding`. */
  role?: string;
  /** Working directory for this task — used to resolve project CLAUDE.md. */
  cwd?: string;
};

export type SendMessageResult = {
  taskId: number;
  interjected: boolean;
  completion: Promise<TaskRunSummary>;
};

// ─── TaskOrchestrator ─────────────────────────────────────────────────────────

export class TaskOrchestrator {
  private readonly infra: InfraPersistence;
  private readonly session: SessionPersistence;
  private readonly emitterFactory: EmitterFactory;

  private readonly liveSessions = new Map<string, SessionContext>();
  private readonly liveSessionEmitters = new Map<string, Emitter>();
  private readonly liveLoops = new Map<number, TaskLoop>();
  private readonly sessionToLoop = new Map<string, number>();
  private readonly taskCompletions = new Map<number, Promise<TaskRunSummary>>();

  constructor(opts: OrchestratorOptions) {
    this.infra = opts.infra;
    this.session = opts.session;
    this.emitterFactory = opts.emitterFactory;
  }

  // ─── Public entry points ───────────────────────────────────────────────────

  /**
   * Scan for orphan tasks (non-terminal status from a crashed previous
   * process) and heal them — inject synthetic tool_results for dangling
   * tool_calls, mark the tasks as `failed`. Idempotent.
   *
   * Should be called once at startup, before any sendUserMessage. CLI
   * bootstrap and daemon entry both call this. Safe to skip in
   * `--memory` ephemeral mode (memory backend has no orphans to find).
   */
  async recoverOrphans(): Promise<RecoveryReport> {
    return recoverOrphans(this.session);
  }

  async createChatSession(title: string = ""): Promise<number> {
    return this.session.sessions.create({ title });
  }

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
        // Anthropic pairing constraint: assistant(tool_use) -> tool(result)
        // must be adjacent. If a tool is in flight when the user interjects,
        // wait for it to complete (and its tool_result to land via
        // tool-execute) before appending the user message. Otherwise the
        // next LLM call would see assistant(tc) -> user -> tool(result)
        // which provider validators reject.
        if (loop.ctx.currentToolPromise) {
          await loop.ctx.currentToolPromise;
        }
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
      this.sessionToLoop.delete(sessionKey);
    }

    return this.startNewTask("chat", input.chatSessionId, sessionContext, input);
  }

  stop(taskId: number): boolean {
    const loop = this.liveLoops.get(taskId);
    if (!loop) return false;
    loop.stop();
    return true;
  }

  async deleteChatSession(sessionId: number): Promise<void> {
    const sessionKey = sessionKeyOf("chat", sessionId);

    const liveTaskId = this.sessionToLoop.get(sessionKey);
    if (liveTaskId !== undefined) {
      const loop = this.liveLoops.get(liveTaskId);
      loop?.stop();
      const completion = this.taskCompletions.get(liveTaskId);
      if (completion) {
        await completion.catch(() => {
          /* swallow - we are tearing down */
        });
      }
    }

    await this.session.sessions.delete(sessionId);

    this.liveSessions.delete(sessionKey);
    this.liveSessionEmitters.delete(sessionKey);
    this.sessionToLoop.delete(sessionKey);
  }

  async awaitTask(taskId: number): Promise<TaskRunSummary> {
    const cached = this.taskCompletions.get(taskId);
    if (cached) return cached;

    const row = await this.session.tasks.get(taskId);
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

    // Resolve the provider's API-key ref into the actual secret BEFORE
    // we touch the DB or build TaskContext - fail fast on missing key.
    // The cwd is also used below for role / CLAUDE.md discovery.
    const cwd = input.cwd ?? process.cwd();
    const apiKey = resolveApiKey(config.apiKeyRef, { cwd });

    // Atomic: insert task + initial user-message entry in one SQLite
    // transaction (SessionPersistence.tasks.createWithInitialEntry).
    // Avoids the "task row but no user message" ghost state that would
    // otherwise appear if the process died between two separate inserts.
    // We then notify SessionContext via append(..., { knownEntryId })
    // so the wire event fires and llmContext gets updated WITHOUT a
    // second DB write.
    const userMetadata: Record<string, unknown> | undefined =
      input.attachments?.length ? { attachments: input.attachments } : undefined;
    const { taskId, entryId } = await this.session.tasks.createWithInitialEntry({
      task: {
        chatSessionId: sessionType === "chat" ? sessionId : null,
        agentSessionId: sessionType === "agent" ? sessionId : null,
        modelId: config.modelId,
        toolCallMode: config.toolCallMode,
        thinkLevel: config.thinkLevel,
        status: "running",
      },
      entry: {
        sessionId,
        sessionType,
        kind: EntryKind.UserMessage,
        role: "user",
        content: input.content,
        ...(userMetadata !== undefined ? { metadata: userMetadata } : {}),
      },
    });

    await sessionContext.append(
      {
        taskId,
        kind: EntryKind.UserMessage,
        role: "user",
        content: input.content,
        ...(userMetadata !== undefined ? { metadata: userMetadata } : {}),
      },
      { knownEntryId: entryId },
    );

    const sessionOwnership =
      sessionType === "chat"
        ? ({ sessionType: "chat", chatSessionId: sessionId } as const)
        : ({ sessionType: "agent", agentSessionId: sessionId } as const);

    // Role-driven system prompt. --role flag (CLI) -> input.role.
    // Defaults to coding. cwd selects the project root for CLAUDE.md
    // discovery; falls back to process.cwd() so non-CLI callers do not
    // have to pass anything.
    const roleName = input.role ?? getConfig().role.default;
    const role = await loadRole(roleName, cwd);
    const systemPrompt = await buildSystemPrompt({ role, cwd });

    // TODO(role-model): if role.frontmatter.model is set, prefer it
    // over input.modelId / app_config.default_model_id. Needs a
    // persistence.models.findByLogicalId(string): Promise<number|null>
    // method first - the orchestrator can not go from "claude-sonnet-4"
    // to a numeric models.id without that. Until then we silently
    // ignore role.frontmatter.model.

    // Per-role tool gating from frontmatter. The current shape is the
    // single composition layer; future per-user / per-task toggles will
    // merge into the same ToolFilterContext (intersect allow, union
    // deny) BEFORE the call. See registry.ts ToolFilterContext docstring.
    const toolFilter: ToolFilterContext = {};
    if (role.frontmatter.tools?.allow !== undefined) {
      toolFilter.allowedTools = role.frontmatter.tools.allow;
    }
    if (role.frontmatter.tools?.deny !== undefined) {
      toolFilter.deniedTools = role.frontmatter.tools.deny;
    }

    // Context window: prefer the value carried by ResolvedModelConfig
    // (which a future models.context_window column would supply);
    // fall back to a string-pattern heuristic on the model id.
    const contextWindow =
      config.contextWindow ?? estimateContextWindow(config.modelId);

    const taskContext = new TaskContext({
      taskId,
      ...sessionOwnership,
      protocol: config.protocol,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKey,
      toolCallMode: config.toolCallMode,
      thinkLevel: config.thinkLevel,
      contextWindow,
      ...(config.defaultHeaders ? { headers: config.defaultHeaders } : {}),
      tools: getToolsForLLM(toolFilter),
      systemPrompt,
      sessionContext,
    });

    const loop = new TaskLoop(taskContext);
    const sessionKey = sessionKeyOf(sessionType, sessionId);
    this.liveLoops.set(taskId, loop);
    this.sessionToLoop.set(sessionKey, taskId);

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
    await this.session.tasks.update(taskId, {
      status: summary.status,
      finalResult: summary.finalResult,
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      totalTokens: summary.totalTokens,
      toolCallCount: summary.toolCallCount,
      iterationCount: summary.iterationCount,
    });

    this.cleanupTask(taskId, sessionKey);

    const emitter = this.liveSessionEmitters.get(sessionKey);
    if (!emitter) return;

    const { sessionType, sessionId } = parseSessionKey(sessionKey);
    const status = isTerminalForEvent(summary.status) ? summary.status : "failed";

    emitter.emit({
      type: "task_terminated",
      taskId,
      sessionId,
      sessionType,
      status,
      summary: toTaskSummary(summary),
    });
  }

  private async handleTaskCrash(
    taskId: number,
    sessionKey: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.session.tasks.update(taskId, {
      status: "failed",
      errorMessage: message,
    });

    this.cleanupTask(taskId, sessionKey);

    const emitter = this.liveSessionEmitters.get(sessionKey);
    if (!emitter) return;

    const { sessionType, sessionId } = parseSessionKey(sessionKey);
    emitter.emit({
      type: "task_error",
      taskId,
      sessionId,
      sessionType,
      error: message,
    });
  }

  private cleanupTask(taskId: number, sessionKey: string): void {
    this.liveLoops.delete(taskId);
    if (this.sessionToLoop.get(sessionKey) === taskId) {
      this.sessionToLoop.delete(sessionKey);
    }
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
    const initialContext = await this.session.entries.loadLLMContext(
      sessionId,
      sessionType,
    );

    const sc = new SessionContext({
      sessionId,
      sessionType,
      persist: this.session.entries.persist,
      updateDb: this.session.entries.update,
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
      const def = await this.infra.config.getDefaultModelId();
      if (def == null) {
        throw new Error(
          "No default model configured. Set app_config.default_model_id (number).",
        );
      }
      id = def;
    }

    const config = await this.infra.models.resolveConfig(id);
    if (!config) throw new Error(`Model id=${id} not found.`);

    return config;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sessionKeyOf(type: SessionType, id: number): string {
  return `${type}:${id}`;
}

function parseSessionKey(key: string): { sessionType: SessionType; sessionId: number } {
  const idx = key.indexOf(":");
  const type = key.slice(0, idx);
  const id = Number(key.slice(idx + 1));
  return {
    sessionType: type === "agent" ? "agent" : "chat",
    sessionId: id,
  };
}

function isTerminalForEvent(s: TaskStatus): s is "done" | "failed" | "stopped" {
  return s === "done" || s === "failed" || s === "stopped";
}

function toTaskSummary(s: TaskRunSummary): TaskSummary {
  return {
    finalResult: s.finalResult,
    hasExplicitResult: s.hasExplicitResult,
    toolCallCount: s.toolCallCount,
    iterationCount: s.iterationCount,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    totalTokens: s.totalTokens,
    elapsedMs: s.elapsedMs,
  };
}

function summaryFromRow(row: TaskRow): TaskRunSummary {
  const status: TaskStatus = isTerminalForEvent(row.status) ? row.status : "failed";
  return {
    status,
    finalResult: row.finalResult,
    hasExplicitResult: row.finalResult.length > 0,
    toolCallCount: row.toolCallCount,
    iterationCount: row.iterationCount,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    elapsedMs: 0,
  };
}
