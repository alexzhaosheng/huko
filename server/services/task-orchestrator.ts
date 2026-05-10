/**
 * server/services/task-orchestrator.ts
 *
 * Glue layer between transport (HTTP/WS, CLI) and the engine.
 *
 * Speaks SessionPersistence + EmitterFactory; never touches infra config
 * (caller pre-resolves a ResolvedModel and hands it via SendMessageInput).
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
  SessionPersistence,
  TaskRow,
} from "../persistence/index.js";
import type { ResolvedModel } from "../config/infra-config-types.js";
import type { TaskSummary } from "../../shared/events.js";
import { loadRole } from "../roles/index.js";
import { getConfig } from "../config/index.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { recoverOrphans, type RecoveryReport } from "../task/resume.js";
import { detectWorkingLanguage } from "../task/language-reminder.js";
import { estimateContextWindow } from "../core/llm/model-context-window.js";
import { resolveApiKey } from "../security/keys.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type EmitterFactory = (room: string) => Emitter;

export type OrchestratorOptions = {
  session: SessionPersistence;
  emitterFactory: EmitterFactory;
};

export type SendMessageInput = {
  chatSessionId: number;
  content: string;
  attachments?: UserAttachment[];
  model: ResolvedModel;
  role?: string;
  cwd?: string;
  interactive?: boolean;
};

export type SendMessageResult = {
  taskId: number;
  interjected: boolean;
  completion: Promise<TaskRunSummary>;
};

// ─── TaskOrchestrator ─────────────────────────────────────────────────────────

export class TaskOrchestrator {
  private readonly session: SessionPersistence;
  private readonly emitterFactory: EmitterFactory;

  private readonly liveSessions = new Map<string, SessionContext>();
  private readonly liveSessionEmitters = new Map<string, Emitter>();
  private readonly liveLoops = new Map<number, TaskLoop>();
  private readonly sessionToLoop = new Map<string, number>();
  private readonly taskCompletions = new Map<number, Promise<TaskRunSummary>>();

  private readonly askResolvers = new Map<
    string,
    {
      taskId: number;
      resolve: (reply: { content: string; attachments?: UserAttachment[] }) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(opts: OrchestratorOptions) {
    this.session = opts.session;
    this.emitterFactory = opts.emitterFactory;
  }

  // ─── Public entry points ───────────────────────────────────────────────────

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
    this.abortAsksForTask(taskId, new Error("Task stopped while waiting for user reply"));
    loop.stop();
    return true;
  }

  respondToAsk(
    toolCallId: string,
    reply: { content: string; attachments?: UserAttachment[] },
  ): boolean {
    const r = this.askResolvers.get(toolCallId);
    if (!r) return false;
    this.askResolvers.delete(toolCallId);
    r.resolve(reply);
    return true;
  }

  pendingAsks(): Array<{ toolCallId: string; taskId: number }> {
    return [...this.askResolvers.entries()].map(([toolCallId, v]) => ({
      toolCallId,
      taskId: v.taskId,
    }));
  }

  private abortAsksForTask(taskId: number, err: Error): void {
    for (const [toolCallId, r] of this.askResolvers) {
      if (r.taskId !== taskId) continue;
      this.askResolvers.delete(toolCallId);
      r.reject(err);
    }
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
    const config = flattenModel(input.model);

    const cwd = input.cwd ?? process.cwd();
    const apiKey = resolveApiKey(config.apiKeyRef, { cwd });

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

    const roleName = input.role ?? getConfig().role.default;
    const role = await loadRole(roleName, cwd);

    // Detect working language up-front so the system prompt's <language>
    // block can lock onto it, and so the language-drift reminder has the
    // same value to compare against. Falls back to null for too-short or
    // mixed input — the prompt then says "use the user's first message"
    // and the drift detector becomes a no-op.
    const workingLanguage = detectWorkingLanguage(input.content);

    const systemPrompt = await buildSystemPrompt({
      role,
      cwd,
      workingLanguage,
    });

    const toolFilter: ToolFilterContext = {
      interactive: input.interactive ?? true,
    };
    if (role.frontmatter.tools?.allow !== undefined) {
      toolFilter.allowedTools = role.frontmatter.tools.allow;
    }
    if (role.frontmatter.tools?.deny !== undefined) {
      toolFilter.deniedTools = role.frontmatter.tools.deny;
    }

    const contextWindow =
      config.contextWindow ?? estimateContextWindow(config.modelId);

    const askResolvers = this.askResolvers;
    const sessionPersistence = this.session;
    const waitForReply: NonNullable<ConstructorParameters<typeof TaskContext>[0]["waitForReply"]> =
      async (payload) => {
        await sessionPersistence.tasks.update(taskId, { status: "waiting_for_reply" });
        sessionContext.emit({
          type: "ask_user",
          taskId,
          toolCallId: payload.toolCallId,
          question: payload.question,
          ...(payload.options ? { options: payload.options } : {}),
          ...(payload.selectionType ? { selectionType: payload.selectionType } : {}),
          ts: Date.now(),
        });
        try {
          return await new Promise<{
            content: string;
            attachments?: UserAttachment[];
          }>((resolve, reject) => {
            askResolvers.set(payload.toolCallId, { taskId, resolve, reject });
          });
        } finally {
          askResolvers.delete(payload.toolCallId);
          try {
            await sessionPersistence.tasks.update(taskId, { status: "running" });
          } catch {
            /* already terminal — ignore */
          }
        }
      };

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
      waitForReply,
    });

    // Reuse the language detected for the system prompt. Drift detector
    // in llm-call.ts compares context against this value.
    taskContext.workingLanguage = workingLanguage;

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

}

// ─── Helpers: model flattening ──────────────────────────────────────────────

function flattenModel(m: ResolvedModel): {
  modelId: string;
  protocol: import("../../shared/llm-protocol.js").Protocol;
  baseUrl: string;
  apiKeyRef: string;
  toolCallMode: import("../../shared/llm-protocol.js").ToolCallMode;
  thinkLevel: import("../../shared/llm-protocol.js").ThinkLevel;
  defaultHeaders: Record<string, string> | null;
  contextWindow?: number;
} {
  return {
    modelId: m.modelId,
    protocol: m.provider.protocol,
    baseUrl: m.provider.baseUrl,
    apiKeyRef: m.provider.apiKeyRef,
    toolCallMode: m.defaultToolCallMode ?? "native",
    thinkLevel: m.defaultThinkLevel ?? "off",
    defaultHeaders: m.provider.defaultHeaders ?? null,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
  };
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
