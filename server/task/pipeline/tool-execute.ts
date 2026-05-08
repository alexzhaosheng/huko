/**
 * server/task/pipeline/tool-execute.ts
 *
 * The tool execution step of the task loop.
 *
 * Responsibilities:
 *   1. Look up the call's tool in the registry.
 *   2. Coerce arguments against the declared schema (best-effort).
 *   3. Dispatch:
 *        - server tool      -> in-process handler invocation
 *        - workstation tool -> ctx.executeTool callback (Socket.IO route)
 *   4. Wrap with Promise.race against ctx.masterAbort so the loop can
 *      cancel mid-tool. The tool may keep running in the background;
 *      we just stop awaiting it.
 *   5. Persist a `tool_result` entry through `sessionContext.append()`.
 *      In native mode the LLM context auto-includes it because role is
 *      "tool" and toolCallId is set.
 *   6. Bump TaskContext.toolCallCount.
 *   7. Honor `ToolHandlerResult.finalResult` / `shouldBreak` / etc. by
 *      lifting them onto the task outcome and surfacing a "break"
 *      outcome to the loop.
 *
 * Errors are caught and surfaced as a tool-result entry with an
 * `error` flag — the LLM can react to them on the next turn rather
 * than the whole task crashing.
 */

import type { TaskContext } from "../../engine/TaskContext.js";
import type { ToolCall } from "../../core/llm/types.js";
import { EntryKind } from "../../../shared/types.js";
import {
  coerceArgs,
  getTool,
  isLegacyServerToolResult,
  isToolHandlerResult,
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
};

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

  // ── 2. Coerce args (best-effort) ─────────────────────────────────────────
  const coerced = coerceArgs(call.name, call.arguments);
  const coercedCall: ToolCall = { ...call, arguments: coerced };

  // ── 3. Execute (race against masterAbort) ────────────────────────────────
  // Track the in-flight tool promise on TaskContext so the orchestrator's
  // interject path can await it before appending user_message — preserves
  // assistant(tool_use) → tool(result) adjacency required by Anthropic.
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

  // ── 4. Lift finalResult onto TaskContext ─────────────────────────────────
  if (outcome.finalResult !== undefined && outcome.finalResult.length > 0) {
    ctx.finalResult = outcome.finalResult;
    ctx.hasExplicitResult = true;
  }

  // ── 5. Persist ───────────────────────────────────────────────────────────
  const extraMeta: Record<string, unknown> = {};
  if (outcome.metadata) Object.assign(extraMeta, outcome.metadata);
  if (outcome.summary !== undefined) extraMeta["summary"] = outcome.summary;
  if (outcome.attachments && outcome.attachments.length > 0) {
    extraMeta["attachments"] = outcome.attachments;
  }

  const entryId = await persistResult(ctx, coercedCall, outcome.result, outcome.error, extraMeta);

  ctx.toolCallCount += 1;

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

  // server tool
  const handlerOutput = await Promise.resolve(tool.handler(call.arguments, ctx));
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
  // Should never happen — handler returned something exotic.
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
