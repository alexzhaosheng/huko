/**
 * server/task/pipeline/tool-execute.ts
 *
 * The tool execution step of the task loop.
 *
 * Responsibilities:
 *   1. Look up the call's tool in the registry.
 *   2. Coerce arguments against the declared schema.
 *   3. Dispatch (server / workstation tool).
 *   4. Race against masterAbort.
 *   5. Persist tool_result via sessionContext.append.
 *   6. Bump counters; lift finalResult / shouldBreak.
 *   7. Drain postReminders + BehaviorGuard.afterToolExecution AFTER the
 *      tool_result entry lands so the assistant(tool_use) -> tool(result)
 *      adjacency Anthropic requires stays intact.
 */

import type { TaskContext } from "../../engine/TaskContext.js";
import type { ToolCall } from "../../core/llm/types.js";
import { EntryKind } from "../../../shared/types.js";
import {
  coerceArgs,
  getTool,
  isLegacyServerToolResult,
  isToolHandlerResult,
  type PostReminder,
  type ServerToolResult,
  type ToolAttachment,
  type ToolHandlerResult,
} from "../tools/registry.js";

// ─── Result type ──────────────────────────────────────────────────────────────

export type ToolExecOutcome =
  | { kind: "ok"; entryId: number; result: string; shouldBreak?: boolean }
  | { kind: "error"; entryId: number; error: string }
  | { kind: "aborted" };

// ─── Internal normalised handler output ──────────────────────────────────────

type Normalised = {
  result: string;
  error: string | null;
  metadata?: Record<string, unknown>;
  finalResult?: string;
  shouldBreak?: boolean;
  summary?: string;
  attachments?: ToolAttachment[];
  postReminders?: PostReminder[];
};

// ─── Public API ───────────────────────────────────────────────────────────────

export async function executeAndPersist(
  ctx: TaskContext,
  call: ToolCall,
): Promise<ToolExecOutcome> {
  if (ctx.isAborted) return { kind: "aborted" };

  const tool = getTool(call.name);

  if (!tool) {
    const error = `Tool "${call.name}" is not registered.`;
    const entryId = await persistResult(ctx, call, "", error, { unknownTool: true });
    return { kind: "error", entryId, error };
  }

  const coerced = coerceArgs(call.name, call.arguments);
  const coercedCall: ToolCall = { ...call, arguments: coerced };

  let outcome: Normalised;
  const racePromise = raceAbort(ctx, () => runTool(ctx, coercedCall, tool));
  ctx.currentToolPromise = racePromise.catch(() => undefined);
  try {
    outcome = await racePromise;
  } catch (err: unknown) {
    if (isAbort(err)) {
      ctx.currentToolPromise = null;
      return { kind: "aborted" };
    }
    outcome = { result: "", error: errorMessage(err) };
  } finally {
    ctx.currentToolPromise = null;
  }

  if (ctx.isAborted) return { kind: "aborted" };

  if (outcome.finalResult !== undefined && outcome.finalResult.length > 0) {
    ctx.finalResult = outcome.finalResult;
    ctx.hasExplicitResult = true;
  }

  const extraMeta: Record<string, unknown> = {};
  if (outcome.metadata) Object.assign(extraMeta, outcome.metadata);
  if (outcome.summary !== undefined) extraMeta["summary"] = outcome.summary;
  if (outcome.attachments && outcome.attachments.length > 0) {
    extraMeta["attachments"] = outcome.attachments;
  }

  const entryId = await persistResult(ctx, coercedCall, outcome.result, outcome.error, extraMeta);

  ctx.toolCallCount += 1;

  // Post-reminders: tool-emitted then BehaviorGuard. Both go via
  // appendReminder so the LLM sees a uniform <system_reminder> tag.
  const allReminders: PostReminder[] = [];
  if (outcome.postReminders && outcome.postReminders.length > 0) {
    allReminders.push(...outcome.postReminders);
  }
  const guardReminders = ctx.behavior.afterToolExecution(
    coercedCall.name,
    coercedCall.arguments,
    outcome.error !== null,
  );
  if (guardReminders.length > 0) {
    allReminders.push(...guardReminders);
  }
  for (const r of allReminders) {
    await ctx.sessionContext.appendReminder({
      taskId: ctx.taskId,
      reason: r.reason,
      content: r.content,
    });
  }

  if (outcome.error) {
    return { kind: "error", entryId, error: outcome.error };
  }

  if (outcome.shouldBreak) {
    return { kind: "ok", entryId, result: outcome.result, shouldBreak: true };
  }
  return { kind: "ok", entryId, result: outcome.result };
}

// ─── Internal: dispatch ──────────────────────────────────────────────────────

async function runTool(
  ctx: TaskContext,
  call: ToolCall,
  tool: NonNullable<ReturnType<typeof getTool>>,
): Promise<Normalised> {
  if (tool.kind === "workstation") {
    if (!ctx.executeTool) {
      return {
        result: "",
        error: `Workstation tool "${call.name}" called but no workstation is connected.`,
      };
    }
    const r = await ctx.executeTool(call.name, call.arguments);
    const res: Normalised = {
      result: r.result,
      error: r.error,
    };
    if (r.screenshot) res.metadata = { screenshot: r.screenshot };
    return res;
  }

  const handlerOutput = await Promise.resolve(
    tool.handler(call.arguments, ctx, { toolCallId: call.id }),
  );
  return normaliseHandlerOutput(handlerOutput);
}

function normaliseHandlerOutput(
  out: string | ServerToolResult | ToolHandlerResult,
): Normalised {
  if (typeof out === "string") {
    return { result: out, error: null };
  }
  if (isToolHandlerResult(out)) {
    const n: Normalised = {
      result: out.content,
      error: out.error ?? null,
    };
    if (out.metadata) n.metadata = out.metadata;
    if (out.finalResult !== undefined) n.finalResult = out.finalResult;
    if (out.shouldBreak) n.shouldBreak = true;
    if (out.summary !== undefined) n.summary = out.summary;
    if (out.attachments) n.attachments = out.attachments;
    if (out.postReminders && out.postReminders.length > 0) n.postReminders = out.postReminders;
    return n;
  }
  if (isLegacyServerToolResult(out)) {
    const n: Normalised = {
      result: out.result,
      error: out.error ?? null,
    };
    if (out.metadata) n.metadata = out.metadata;
    return n;
  }
  return { result: String(out), error: null };
}

// ─── Internal: persistence ───────────────────────────────────────────────────

async function persistResult(
  ctx: TaskContext,
  call: ToolCall,
  result: string,
  error: string | null,
  extraMetadata: Record<string, unknown>,
): Promise<number> {
  const metadata: Record<string, unknown> = {
    toolName: call.name,
    arguments: call.arguments,
    ...extraMetadata,
  };
  if (error !== null) metadata["error"] = error;

  return ctx.sessionContext.append({
    taskId: ctx.taskId,
    kind: EntryKind.ToolResult,
    role: "tool",
    content: selectToolResultContent(result, error),
    toolCallId: call.id,
    metadata,
  });
}

/**
 * Pick the string that goes on the persisted `tool_result` entry — the
 * one the LLM sees in its conversation history.
 *
 * Tool handlers explicitly populate the `content` field with the message
 * they want the LLM to see (e.g. "Error: edits[2].find must be a string.").
 * The `error` field is a SHORT machine-readable code ("bad edit shape")
 * meant for filtering / telemetry. Earlier code synthesized
 * `Error: ${error}` for any failed call, which discarded the handler's
 * diagnostic detail — the LLM would see "Error: bad edit shape" with no
 * hint about which edit or which field.
 *
 * Rules:
 *   - Non-empty `result` (the handler's content): always use it as-is.
 *   - Empty `result` + non-null `error`: synthesize `Error: ${error}`
 *     so the LLM at least sees the short code. Defensive — no current
 *     handler returns empty content + error, but we tolerate it.
 *   - Empty `result` + null `error`: return empty (a clean tool with
 *     no output is a valid state).
 *
 * Exported for unit tests in tests/tool-execute-content.test.ts.
 */
export function selectToolResultContent(result: string, error: string | null): string {
  if (result !== "") return result;
  if (error !== null) return `Error: ${error}`;
  return result;
}

// ─── Internal: abort race ────────────────────────────────────────────────────

function raceAbort<T>(ctx: TaskContext, fn: () => Promise<T>): Promise<T> {
  if (ctx.isAborted) return Promise.reject(makeAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      ctx.masterAbort.signal.removeEventListener("abort", onAbort);
      reject(makeAbortError());
    };
    ctx.masterAbort.signal.addEventListener("abort", onAbort, { once: true });
    fn()
      .then(
        (v) => {
          ctx.masterAbort.signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          ctx.masterAbort.signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
  });
}

function makeAbortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function isAbort(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || /aborted/i.test(err.message);
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
