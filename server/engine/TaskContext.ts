/**
 * server/engine/TaskContext.ts
 *
 * Task-scoped state container. One instance per task run.
 *
 * TaskContext holds everything specific to a single task execution:
 *   - Identifiers (taskId, sessionId, ...)
 *   - LLM call configuration (protocol, baseUrl, model, headers, ...)
 *   - Tools & system prompt
 *   - Runtime callbacks (executeTool, requestApproval, waitForReply)
 *   - Execution accumulators (token counts, tool call count)
 *   - Task outcome (finalResult, status flags)
 *   - Abort plumbing (masterAbort, currentLlmAbort, currentToolPromise)
 *   - Deferred tool-call queue (single-step enforcement)
 *   - Plan state (planState)
 *   - Behaviour counters (behavior) + working language (workingLanguage)
 */

import type { Protocol, ThinkLevel, Tool, ToolCall, ToolCallMode } from "../core/llm/types.js";
import type { SessionOwnership, TaskStatus, UserAttachment } from "../../shared/types.js";
import type { PlanState } from "../../shared/plan-types.js";
import { BehaviorGuard } from "../task/behavior-guard.js";
import type { SessionContext } from "./SessionContext.js";

// ─── Callbacks ────────────────────────────────────────────────────────────────

export type WorkstationExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; error: string | null; screenshot?: string }>;

export type ApprovalCallback = (message: string) => Promise<boolean>;

/**
 * Block until the user replies to a `message(type=ask)` call.
 */
export type WaitForReplyCallback = (payload: {
  toolCallId: string;
  question: string;
  options?: string[];
  selectionType?: "single" | "multiple";
}) => Promise<{ content: string; attachments?: UserAttachment[] }>;

// ─── TaskContext ──────────────────────────────────────────────────────────────

export type TaskContextOptions = SessionOwnership & {
  taskId: number;

  protocol: Protocol;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  contextWindow: number;
  headers?: Record<string, string>;
  extras?: Record<string, unknown>;

  tools: Tool[];
  systemPrompt: string;
  sessionContext: SessionContext;

  executeTool?: WorkstationExecutor;
  requestApproval?: ApprovalCallback;
  waitForReply?: WaitForReplyCallback;

  externalAbortSignal?: AbortSignal;
};

export class TaskContext {
  readonly taskId: number;
  readonly sessionType: "chat" | "agent";
  readonly chatSessionId?: number;
  readonly agentSessionId?: number;

  readonly protocol: Protocol;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly toolCallMode: ToolCallMode;
  readonly thinkLevel: ThinkLevel;
  readonly contextWindow: number;
  readonly headers?: Record<string, string>;
  readonly extras?: Record<string, unknown>;

  tools: Tool[];
  systemPrompt: string;

  readonly sessionContext: SessionContext;

  readonly executeTool?: WorkstationExecutor;
  readonly requestApproval?: ApprovalCallback;
  readonly waitForReply?: WaitForReplyCallback;

  readonly masterAbort: AbortController;
  currentLlmAbort: AbortController | null = null;

  currentToolPromise: Promise<unknown> | null = null;

  toolCallCount: number = 0;
  promptTokens: number = 0;
  completionTokens: number = 0;
  totalTokens: number = 0;
  iterationCount: number = 0;

  deferredCalls: ToolCall[] = [];

  finalResult: string = "";
  hasExplicitResult: boolean = false;
  taskFailed: boolean = false;
  taskStopped: boolean = false;

  interjected: boolean = false;

  /**
   * Current plan state. null when the LLM has not yet called plan(update).
   * Rebuildable from tool_result entries' metadata.planEvents on resume.
   */
  planState: PlanState | null = null;

  /**
   * Per-task behaviour counters (consecutive_info, empty_turn).
   * Orchestrator calls behavior.resetOnUserInteraction() on interjection.
   */
  readonly behavior: BehaviorGuard = new BehaviorGuard();

  /**
   * Working language label (e.g. "中文", "English"). Used by
   * language-reminder.ts to detect script drift in the context tail.
   * Auto-detected from the first user message at task start;
   * null disables drift detection.
   */
  workingLanguage: string | null = null;

  readonly startTime: number = Date.now();

  constructor(opts: TaskContextOptions) {
    this.taskId = opts.taskId;
    this.sessionType = opts.sessionType;

    if (opts.sessionType === "chat") {
      this.chatSessionId = opts.chatSessionId;
    } else {
      this.agentSessionId = opts.agentSessionId;
    }

    this.protocol = opts.protocol;
    this.modelId = opts.modelId;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.toolCallMode = opts.toolCallMode;
    this.thinkLevel = opts.thinkLevel;
    this.contextWindow = opts.contextWindow;
    if (opts.headers !== undefined) this.headers = opts.headers;
    if (opts.extras !== undefined) this.extras = opts.extras;

    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.sessionContext = opts.sessionContext;

    if (opts.executeTool !== undefined) this.executeTool = opts.executeTool;
    if (opts.requestApproval !== undefined) this.requestApproval = opts.requestApproval;
    if (opts.waitForReply !== undefined) this.waitForReply = opts.waitForReply;

    this.masterAbort = new AbortController();
    if (opts.externalAbortSignal) {
      if (opts.externalAbortSignal.aborted) {
        this.masterAbort.abort();
      } else {
        opts.externalAbortSignal.addEventListener(
          "abort",
          () => this.masterAbort.abort(),
          { once: true },
        );
      }
    }
  }

  get sessionId(): number {
    return (this.chatSessionId ?? this.agentSessionId)!;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  get isAborted(): boolean {
    return this.masterAbort.signal.aborted;
  }

  addTokens(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
  }

  summary(): {
    toolCallCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    iterationCount: number;
    elapsedMs: number;
  } {
    return {
      toolCallCount: this.toolCallCount,
      totalTokens: this.totalTokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      iterationCount: this.iterationCount,
      elapsedMs: this.elapsedMs,
    };
  }

  resolveStatus(): TaskStatus {
    if (this.taskStopped) return "stopped";
    if (this.taskFailed) return "failed";
    return "done";
  }

  consumeInterjectionFlag(): boolean {
    const v = this.interjected;
    this.interjected = false;
    return v;
  }
}
