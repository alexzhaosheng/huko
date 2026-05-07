/**
 * server/engine/TaskContext.ts
 *
 * Task-scoped state container. One instance per task run.
 *
 * TaskContext holds everything specific to a single task execution:
 *   - Identifiers (taskId, userId, sessionId, ...)
 *   - LLM call configuration (protocol, baseUrl, model, headers, ...)
 *   - Tools & system prompt
 *   - Runtime callbacks (executeTool, requestApproval, waitForReply)
 *   - Execution accumulators (token counts, tool call count)
 *   - Task outcome (finalResult, status flags)
 *   - Abort plumbing (masterAbort owned here, currentLlmAbort set by pipeline)
 *   - Deferred tool-call queue (single-step enforcement)
 *
 * What TaskContext does NOT hold:
 *   - The LLM context array — that lives in SessionContext (session-scoped)
 *   - Business logic — TaskContext is a data holder, not a coordinator
 *
 * The active SessionContext is referenced here so the pipeline can call
 * sessionContext.append() / update() without threading it through every
 * function signature.
 */

import type { Protocol, ThinkLevel, Tool, ToolCall, ToolCallMode } from "../core/llm/types.js";
import type { SessionOwnership, TaskStatus, UserAttachment } from "../../shared/types.js";
import type { SessionContext } from "./SessionContext.js";

// ─── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Execute a tool on the user's local machine (Workstation path).
 * Returns the raw result string and an optional screenshot.
 */
export type WorkstationExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; error: string | null; screenshot?: string }>;

/**
 * Pause the task, show an approval prompt, and wait for the user's decision.
 * Resolves to `true` (approved) or `false` (declined).
 */
export type ApprovalCallback = (message: string) => Promise<boolean>;

/**
 * Pause the task, send an ask message, and wait for the user's reply.
 * Resolves with the reply text and any attached files.
 */
export type WaitForReplyCallback = (payload: {
  messageId: number;
  content: string;
  metadata?: Record<string, unknown>;
}) => Promise<{ content: string; attachments?: UserAttachment[] }>;

// ─── TaskContext ──────────────────────────────────────────────────────────────

export type TaskContextOptions = SessionOwnership & {
  // ── Identifiers ────────────────────────────────────────────────────────────
  taskId: number;

  // ── Model / LLM call ──────────────────────────────────────────────────────
  protocol: Protocol;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  /** Provider-specific headers (e.g. OpenRouter HTTP-Referer / X-Title). */
  headers?: Record<string, string>;
  /** Provider-specific request-body extras forwarded to invoke(). */
  extras?: Record<string, unknown>;

  // ── Tools ──────────────────────────────────────────────────────────────────
  /** Tools available to the LLM for this task. Updated by the pipeline when filters change. */
  tools: Tool[];

  // ── System prompt ──────────────────────────────────────────────────────────
  systemPrompt: string;

  // ── Session reference ──────────────────────────────────────────────────────
  sessionContext: SessionContext;

  // ── Callbacks ──────────────────────────────────────────────────────────────
  /** Execute a Workstation tool. Absent in server-only mode. */
  executeTool?: WorkstationExecutor;
  requestApproval?: ApprovalCallback;
  waitForReply?: WaitForReplyCallback;

  // ── Abort ──────────────────────────────────────────────────────────────────
  /**
   * Optional external abort signal. If provided, an abort on it will
   * propagate into TaskContext.masterAbort. The TaskContext still owns
   * its own controller — the external signal is merely a feed-in.
   */
  externalAbortSignal?: AbortSignal;
};

export class TaskContext {
  // ── Identifiers ─────────────────────────────────────────────────────────────
  readonly taskId: number;
  readonly sessionType: "chat" | "agent";
  readonly chatSessionId?: number;
  readonly agentSessionId?: number;

  // ── Model / LLM call ────────────────────────────────────────────────────────
  readonly protocol: Protocol;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly toolCallMode: ToolCallMode;
  readonly thinkLevel: ThinkLevel;
  readonly headers?: Record<string, string>;
  readonly extras?: Record<string, unknown>;

  // ── Tools (mutable — pipeline rebuilds when filters change) ──────────────────
  tools: Tool[];

  // ── System prompt (mutable — skill activation can append to it) ──────────────
  systemPrompt: string;

  // ── Session reference ────────────────────────────────────────────────────────
  readonly sessionContext: SessionContext;

  // ── Callbacks ────────────────────────────────────────────────────────────────
  readonly executeTool?: WorkstationExecutor;
  readonly requestApproval?: ApprovalCallback;
  readonly waitForReply?: WaitForReplyCallback;

  // ── Abort plumbing ───────────────────────────────────────────────────────────
  /** Master abort. Triggered by `stop()` or by an aborted external signal. */
  readonly masterAbort: AbortController;
  /** Current LLM call's abort, set by pipeline before each call, cleared after. */
  currentLlmAbort: AbortController | null = null;

  // ── Execution accumulators (mutated by pipeline) ─────────────────────────────
  toolCallCount: number = 0;
  promptTokens: number = 0;
  completionTokens: number = 0;
  totalTokens: number = 0;
  /** How many LLM iterations we've made — main loop uses this for budgets. */
  iterationCount: number = 0;

  // ── Deferred tool-call queue (single-step enforcement) ───────────────────────
  /**
   * When the LLM emits multiple tool calls in one turn, only the first
   * is executed immediately; the rest land here and are drained one per
   * loop iteration before the next LLM call.
   */
  deferredCalls: ToolCall[] = [];

  // ── Task outcome ─────────────────────────────────────────────────────────────
  /** Set by the `message` tool, by explicit completion, or by the final assistant turn. */
  finalResult: string = "";
  /** True once `finalResult` has been explicitly set (vs. empty default). */
  hasExplicitResult: boolean = false;
  taskFailed: boolean = false;
  taskStopped: boolean = false;

  // ── Runtime flags (set by TaskLoop) ──────────────────────────────────────────
  /** True if the user has interjected since the last consumption. */
  interjected: boolean = false;

  // ── Timing ───────────────────────────────────────────────────────────────────
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
    if (opts.headers !== undefined) this.headers = opts.headers;
    if (opts.extras !== undefined) this.extras = opts.extras;

    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.sessionContext = opts.sessionContext;

    if (opts.executeTool !== undefined) this.executeTool = opts.executeTool;
    if (opts.requestApproval !== undefined) this.requestApproval = opts.requestApproval;
    if (opts.waitForReply !== undefined) this.waitForReply = opts.waitForReply;

    // Master abort always exists. Optional external signal feeds in.
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

  // ─── Convenience ──────────────────────────────────────────────────────────

  /** The session id (chat or agent, whichever applies). */
  get sessionId(): number {
    return (this.chatSessionId ?? this.agentSessionId)!;
  }

  /** Elapsed milliseconds since the task started. */
  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** True if the master abort signal has fired. */
  get isAborted(): boolean {
    return this.masterAbort.signal.aborted;
  }

  /** Accumulate token usage from a single LLM turn. */
  addTokens(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
  }

  /** Summarise final token and tool call counts (for task:done payload). */
  summary(): { toolCallCount: number; totalTokens: number; promptTokens: number; completionTokens: number; iterationCount: number; elapsedMs: number } {
    return {
      toolCallCount: this.toolCallCount,
      totalTokens: this.totalTokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      iterationCount: this.iterationCount,
      elapsedMs: this.elapsedMs,
    };
  }

  /** Resolve the terminal task status from the outcome flags. */
  resolveStatus(): TaskStatus {
    if (this.taskStopped) return "stopped";
    if (this.taskFailed) return "failed";
    return "done";
  }

  /**
   * Consume the interjection flag — returns its current value and resets
   * it to false. Used by TaskLoop at the top of each iteration.
   */
  consumeInterjectionFlag(): boolean {
    const v = this.interjected;
    this.interjected = false;
    return v;
  }
}
