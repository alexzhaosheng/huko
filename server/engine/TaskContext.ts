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
 */

import type { Protocol, ThinkLevel, Tool, ToolCall, ToolCallMode } from "../core/llm/types.js";
import type { SessionOwnership, TaskStatus, UserAttachment } from "../../shared/types.js";
import type { SessionContext } from "./SessionContext.js";

// ─── Callbacks ────────────────────────────────────────────────────────────────

export type WorkstationExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; error: string | null; screenshot?: string }>;

export type ApprovalCallback = (message: string) => Promise<boolean>;

/**
 * Block until the user replies to a `message(type=ask)` call. The
 * orchestrator wires this up; tool handlers call it to wait for a
 * reply.
 *
 * Keying: `toolCallId` is the LLM-assigned unique id of the assistant's
 * tool call. The orchestrator's resolver registry uses this as the key,
 * so multiple concurrent asks (future daemon mode, agents, etc.) never
 * collide. The resolution channel is whatever the frontend wires up —
 * stdin in CLI, Socket.IO + tRPC mutation in daemon mode.
 *
 * Return value: `{ content, attachments? }`. `content` becomes the
 * tool_result text the LLM sees on the next turn.
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
  /**
   * The model's context window in tokens. Used by `pipeline/context-manage.ts`
   * to scale compaction thresholds. Required — orchestrator fills via
   * `estimateContextWindow(modelId)` when persistence has no value.
   */
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

  // ── Abort plumbing ───────────────────────────────────────────────────────────
  readonly masterAbort: AbortController;
  /** Current LLM call's abort, set by pipeline before each call, cleared after. */
  currentLlmAbort: AbortController | null = null;

  /**
   * Current in-flight tool execution. Tool-execute sets this before the
   * await and clears it after. Used by orchestrator.sendUserMessage to
   * defer user-message append until the tool_result has landed —
   * Anthropic requires assistant(tool_use) -> tool(result) to remain
   * adjacent. Without this, an interjection mid-tool produces:
   *   assistant(tool_use) -> user(text) -> tool(result)
   * which the next LLM call rejects with a 400.
   */
  currentToolPromise: Promise<unknown> | null = null;

  toolCallCount: number = 0;
  promptTokens: number = 0;
  completionTokens: number = 0;
  totalTokens: number = 0;
  iterationCount: number = 0;

  /**
   * When the LLM emits multiple tool calls in one turn, only the first
   * is executed immediately; the rest land here and are drained one per
   * loop iteration before the next LLM call.
   */
  deferredCalls: ToolCall[] = [];

  finalResult: string = "";
  hasExplicitResult: boolean = false;
  taskFailed: boolean = false;
  taskStopped: boolean = false;

  /** True if the user has interjected since the last consumption. */
  interjected: boolean = false;

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
