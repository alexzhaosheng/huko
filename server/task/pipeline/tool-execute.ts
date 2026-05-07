/**
 * server/task/pipeline/tool-execute.ts
 *
 * The tool execution step of the task loop.
 *
 * Responsibilities:
 *   1. Look up the call's tool in the registry.
 *   2. Dispatch:
 *        - server tool      → in-process handler invocation
 *        - workstation tool → ctx.executeTool callback (Socket.IO route)
 *   3. Wrap with Promise.race against ctx.masterAbort so the loop can
 *      cancel mid-tool. The tool may keep running in the background;
 *      we just stop awaiting it.
 *   4. Persist a `tool_result` entry through `sessionContext.append()`.
 *      In native mode the LLM context auto-includes it because role is
 *      "tool" and toolCallId is set.
 *   5. Bump TaskContext.toolCallCount.
 *
 * Errors are caught and surfaced as a tool-result entry with an
 * `error` flag — the LLM can react to them on the next turn rather
 * than the whole task crashing.
 */

import type { TaskContext } from "../../engine/TaskContext.js";
import type { ToolCall } from "../../core/llm/types.js";
import { EntryKind } from "../../../shared/types.js";
import { getTool, type ServerToolResult } from "../tools/registry.js";

// ─── Result type ──────────────────────────────────────────────────────────────

export type ToolExecOutcome =
  | { kind: "ok"; entryId: number; result: string }
  | { kind: "error"; entryId: number; error: string }
  | { kind: "aborted" };

// ─── Public API ───────────────────────────────────────────────────────────────

export async function executeAndPersist(
  ctx: TaskContext,
  call: ToolCall,
): Promise<ToolExecOutcome> {
  if (ctx.isAborted) return { kind: "aborted" };

  const tool = getTool(call.name);

  // ── 1. Unknown tool → record the error so the LLM can correct itself ─────
  if (!tool) {
    const error = `Tool "${call.name}" is not registered.`;
    const entryId = await persistResult(ctx, call, "", error, { unknownTool: true });
    return { kind: "error", entryId, error };
  }

  // ── 2. Execute (race against masterAbort) ────────────────────────────────
  let outcome: { result: string; error: string | null; metadata?: Record<string, unknown> };
  try {
    outcome = await raceAbort(ctx, () => runTool(ctx, call, tool));
  } catch (err: unknown) {
    if (isAbort(err)) return { kind: "aborted" };
    outcome = { result: "", error: errorMessage(err) };
  }

  if (ctx.isAborted) return { kind: "aborted" };

  // ── 3. Persist ───────────────────────────────────────────────────────────
  const entryId = await persistResult(ctx, call, outcome.result, outcome.error, {
    ...(outcome.metadata ?? {}),
  });

  ctx.toolCallCount += 1;

  return outcome.error
    ? { kind: "error", entryId, error: outcome.error }
    : { kind: "ok", entryId, result: outcome.result };
}

// ─── Internal: dispatch ──────────────────────────────────────────────────────

async function runTool(
  ctx: TaskContext,
  call: ToolCall,
  tool: NonNullable<ReturnType<typeof getTool>>,
): Promise<{ result: string; error: string | null; metadata?: Record<string, unknown> }> {
  if (tool.kind === "workstation") {
    if (!ctx.executeTool) {
      return {
        result: "",
        error: `Workstation tool "${call.name}" called but no workstation is connected.`,
      };
    }
    const r = await ctx.executeTool(call.name, call.arguments);
    return {
      result: r.result,
      error: r.error,
      ...(r.screenshot ? { metadata: { screenshot: r.screenshot } } : {}),
    };
  }

  // server tool
  const handlerOutput = await Promise.resolve(tool.handler(call.arguments, ctx));
  return normaliseHandlerOutput(handlerOutput);
}

function normaliseHandlerOutput(
  out: string | ServerToolResult,
): { result: string; error: string | null; metadata?: Record<string, unknown> } {
  if (typeof out === "string") return { result: out, error: null };
  return {
    result: out.result,
    error: out.error ?? null,
    ...(out.metadata ? { metadata: out.metadata } : {}),
  };
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
    content: error !== null ? `Error: ${error}` : result,
    toolCallId: call.id,
    metadata,
  });
}

// ─── Internal: abort race ────────────────────────────────────────────────────

/**
 * Run `fn()` and reject with an Error("aborted") as soon as the master
 * abort fires. The underlying tool may keep running in the background;
 * we stop awaiting it so the loop can move on.
 */
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
