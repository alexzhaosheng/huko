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
  type RegisteredTool,
  type ServerToolDefinition,
  type ServerToolResult,
  type ToolAttachment,
  type ToolHandlerResult,
} from "../tools/registry.js";
import { evaluatePolicy, type PolicyDecision } from "../../safety/policy.js";
import { appendRule } from "../../safety/persist.js";
import { getConfig } from "../../config/index.js";

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

  // ── Safety policy gate ─────────────────────────────────────────────────
  // Evaluate per-tool rules + dangerLevel default BEFORE running the
  // handler. If denied (by rule, by missing operator confirmation, or
  // by operator's "no" reply), persist a `policy_denied` tool_result and
  // skip handler execution entirely — the LLM gets to see the reason
  // and can retry differently.
  const refusal = await applyPolicyGate(ctx, coercedCall, tool.definition);
  if (refusal !== null) {
    const entryId = await persistResult(
      ctx,
      coercedCall,
      refusal.content,
      refusal.error,
      { policy: refusal.metadata },
    );
    ctx.toolCallCount += 1;
    return { kind: "error", entryId, error: refusal.error };
  }

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

// ─── Internal: safety policy gate ────────────────────────────────────────────

type Refusal = {
  content: string;
  error: string;
  metadata: Record<string, unknown>;
};

/**
 * Evaluate the safety policy for this call and decide whether to let
 * the handler run. Returns `null` on go-ahead, or a `Refusal` envelope
 * to be persisted as the tool_result when denied.
 *
 * Flow:
 *   1. evaluatePolicy() — pure decision from rules + dangerLevel.
 *   2. "auto" → null (run handler).
 *   3. "deny" → refusal envelope.
 *   4. "prompt":
 *        a. No requestDecision port (non-interactive run): refusal
 *           (fail-closed; see PRINCIPLES in safety/types).
 *        b. Port present: invoke it, route the operator's choice:
 *           - allow              → null
 *           - deny               → refusal
 *           - allow_and_remember → append matched pattern to global
 *             allow list, then null. Persist errors are non-fatal —
 *             log to stderr and proceed.
 */
async function applyPolicyGate(
  ctx: TaskContext,
  call: ToolCall,
  def: ServerToolDefinition,
): Promise<Refusal | null> {
  const dangerLevel = def.dangerLevel ?? "safe";
  const decision: PolicyDecision = evaluatePolicy({
    toolName: call.name,
    args: call.arguments,
    dangerLevel,
    safety: getConfig().safety,
  });

  if (decision.action === "auto") return null;

  if (decision.action === "deny") {
    return refusalFromDecision(decision, "policy_denied");
  }

  // decision.action === "prompt"
  if (!ctx.requestDecision) {
    // Non-interactive run: fail-closed. Don't ask, don't run.
    return refusalFromDecision(
      decision,
      "policy_denied_non_interactive",
      "Tool call would require confirmation but no operator is available " +
        "(non-interactive run). To proceed in CI, either remove this " +
        "requireConfirm rule or add an explicit `allow` pattern.",
    );
  }

  let outcome;
  try {
    outcome = await ctx.requestDecision({
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
      reason: decision.reason ?? "",
      ...(decision.matchedPattern !== undefined
        ? { matchedPattern: decision.matchedPattern }
        : {}),
      ...(decision.matchedField !== undefined
        ? { matchedField: decision.matchedField }
        : {}),
      ...(decision.matchedValue !== undefined
        ? { matchedValue: decision.matchedValue }
        : {}),
    });
  } catch (err) {
    // Frontend died / aborted while awaiting input — treat as deny.
    return refusalFromDecision(
      decision,
      "policy_denied_decision_failed",
      `Confirmation port failed: ${errorMessage(err)}`,
    );
  }

  if (outcome.kind === "deny") {
    return refusalFromDecision(decision, "user_denied", "Operator declined.");
  }

  if (outcome.kind === "allow_and_remember") {
    // Persist the matched pattern as a global allow rule. Best-effort —
    // on disk error, still let the call proceed. The operator already
    // approved this one; we don't want to ALSO fail the call because
    // of a flaky write.
    if (decision.matchedPattern !== undefined && ctx.cwd !== undefined) {
      try {
        appendRule(
          "global",
          ctx.cwd,
          call.name,
          "allow",
          decision.matchedPattern,
        );
      } catch (err) {
        process.stderr.write(
          `huko: failed to persist "always allow" rule: ${errorMessage(err)}\n`,
        );
      }
    }
  }

  return null;
}

function refusalFromDecision(
  decision: PolicyDecision,
  errorCode: string,
  extraExplanation?: string,
): Refusal {
  // Build a verbose content string the LLM can act on — the rule, the
  // matched field/value, and a human-readable next-step hint.
  const parts: string[] = [];
  parts.push(`Refused by safety policy: ${errorCode}.`);
  if (decision.action !== "auto" && decision.reason) {
    parts.push(`Reason: ${decision.reason}.`);
  }
  if (decision.action !== "auto" && decision.matchedValue !== undefined) {
    parts.push(`Matched value: \`${decision.matchedValue}\`.`);
  }
  if (extraExplanation) parts.push(extraExplanation);

  const metadata: Record<string, unknown> = {
    decision: decision.action,
    source: decision.action !== "auto" ? decision.source : undefined,
  };
  if (decision.action !== "auto") {
    if (decision.reason) metadata["reason"] = decision.reason;
    if (decision.matchedPattern !== undefined) metadata["pattern"] = decision.matchedPattern;
    if (decision.matchedField !== undefined) metadata["field"] = decision.matchedField;
  }

  return {
    content: parts.join(" "),
    error: errorCode,
    metadata,
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
