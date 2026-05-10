/**
 * server/task/tools/registry.ts
 *
 * Tool registry — v2.
 *
 * Two registration entry points:
 *   - `registerServerTool(def, handler)`     — runs in-process on the server
 *   - `registerWorkstationTool(def)`         — dispatched to the user's local
 *                                              machine via the executeTool
 *                                              callback on TaskContext
 *
 * Tool files self-register at module load time. `tools/index.ts` does
 * side-effect imports of every tool file; importing `tools/index.ts`
 * once at TaskLoop startup populates the registry.
 *
 * `getToolsForLLM(filter)` builds the tool list passed to the LLM.
 *
 * v2 additions (lifted from WeavesAI's battle-tested implementation):
 *   - `ToolHandlerResult` — handlers can return rich semantic outcomes
 *       beyond a plain string: finalResult / shouldBreak / metadata /
 *       attachments / summary / error / postReminders.
 *   - `coerceArgs(name, args)` — runtime type coercion for tool arguments,
 *       so an LLM that hands us `"true"` instead of `true` for a boolean
 *       parameter is patched up before the handler runs.
 *   - `setToolPolicy(name, meta)` / `getToolPolicy(name)` — danger-level
 *       and admin metadata, used by the pipeline for filtering and
 *       (later) approval.
 *   - `ServerToolDefinition` — extends Tool with optional platformNotes
 *       + dangerLevel, again following WeavesAI.
 */

import type { Tool, ToolParameterSchema } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";

// ─── ToolHandlerResult ────────────────────────────────────────────────────────

/**
 * Rich return value from a server tool handler.
 *
 * - `content`     — the string the LLM sees as the tool result.
 * - `metadata`    — extra structured data attached to the tool_result entry.
 * - `finalResult` — when set, becomes the task's `finalResult`.
 *                   Used by `message` (mode=result) and `agent` (return).
 * - `shouldBreak` — when true, TaskLoop exits cleanly (status=done) AFTER
 *                   the current tool persists. No further LLM call.
 * - `summary`     — short human-readable summary, for UI compaction.
 * - `attachments` — files produced by the tool (paths the user can open).
 * - `error`       — non-null marks this as an error result (the LLM still
 *                   sees `content`, but the entry is flagged).
 * - `postReminders` — system reminders to inject AFTER the tool_result
 *                   entry is persisted. Required when a handler wants
 *                   to nudge the LLM about future behaviour: emitting
 *                   the reminder inline before tool_result would break
 *                   Anthropic's `assistant(tool_use) -> tool(result)`
 *                   adjacency.
 */
export type ToolHandlerResult = {
  content: string;
  metadata?: Record<string, unknown>;
  finalResult?: string;
  shouldBreak?: boolean;
  summary?: string;
  attachments?: ToolAttachment[];
  error?: string | null;
  postReminders?: PostReminder[];
};

/** A system reminder to be appended right after the tool_result entry. */
export type PostReminder = {
  /** Stable identifier (e.g. `plan_update_followup`). Used for metadata + future de-dup. */
  reason: string;
  /** Free-form body (no <system_reminder> tag — SessionContext wraps it). */
  content: string;
};

export type ToolAttachment = {
  filename: string;
  mimeType: string;
  size?: number;
  /** Server-relative or absolute path. The UI / CLI render will pick this up. */
  path: string;
};

/**
 * Per-call metadata passed to handlers that need to know about the
 * specific tool_use the LLM emitted — currently used by `message`'s
 * `ask` mode to key its waitForReply Promise on `toolCallId`.
 *
 * Optional 3rd parameter so existing handlers don't have to be touched.
 */
export type ToolCallMeta = {
  /** Stable id of this tool call (from the LLM's response). */
  toolCallId: string;
};

/**
 * Server-tool handler. Runs in the same process as TaskLoop.
 *
 * Allowed return shapes:
 *   - `string`              — fast path: just the tool result.
 *   - `ServerToolResult`    — backwards-compatible structured result.
 *   - `ToolHandlerResult`   — full v2 semantic result.
 *   - throwing              — caught and converted to an error result.
 */
export type ServerToolHandler = (
  args: Record<string, unknown>,
  ctx: TaskContext,
  callMeta?: ToolCallMeta,
) => Promise<string | ServerToolResult | ToolHandlerResult>
  | string
  | ServerToolResult
  | ToolHandlerResult;

/**
 * Backwards-compatible shape — kept so old tools (none today, but the
 * type was exposed) still type-check.
 */
export type ServerToolResult = {
  result: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

// ─── Tool definition (v2) ────────────────────────────────────────────────────

export type ServerToolDefinition = Tool & {
  /** Per-platform instruction blocks appended to `description` at filter time. */
  platformNotes?: Partial<Record<NodeJS.Platform, string>>;
  dangerLevel?: ToolDangerLevel;
  /**
   * Generate a per-call JSON schema based on the filter context (e.g.
   * `interactive: false` → drop the `ask` mode from the `message`
   * tool's allowed `type` values). When omitted, the static
   * `parameters` is used unchanged.
   *
   * Called by `getToolsForLLM` at LLM-call time, NOT at tool execution
   * time — the schema goes into the LLM payload, the handler still
   * receives raw args from the LLM and decides what to do with them.
   */
  parametersFor?: (ctx: ToolMaterializeContext) => Tool["parameters"];
  /**
   * Generate a per-call description supplement (appended after the
   * static description + platform note). Useful when ask-only
   * instructions should be dropped along with the schema field.
   */
  descriptionFor?: (ctx: ToolMaterializeContext) => string | undefined;
};

export type WorkstationToolDefinition = ServerToolDefinition;

// ─── Policy ──────────────────────────────────────────────────────────────────

export type ToolDangerLevel = "safe" | "moderate" | "dangerous";

export type ToolPolicyMeta = {
  dangerLevel?: ToolDangerLevel;
  requiresAdmin?: boolean;
};

const policyRegistry = new Map<string, ToolPolicyMeta>();

export function setToolPolicy(toolName: string, policy: ToolPolicyMeta): void {
  policyRegistry.set(toolName, policy);
}

export function getToolPolicy(toolName: string): ToolPolicyMeta {
  return policyRegistry.get(toolName) ?? { dangerLevel: "safe" };
}

// ─── Internal registry shape ──────────────────────────────────────────────────

type RegisteredTool =
  | { kind: "server"; definition: ServerToolDefinition; handler: ServerToolHandler }
  | { kind: "workstation"; definition: WorkstationToolDefinition };

const registry = new Map<string, RegisteredTool>();

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerServerTool(
  definition: ServerToolDefinition,
  handler: ServerToolHandler,
): void {
  if (registry.has(definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered.`);
  }
  registry.set(definition.name, { kind: "server", definition, handler });
  if (definition.dangerLevel !== undefined) {
    setToolPolicy(definition.name, { dangerLevel: definition.dangerLevel });
  }
}

export function registerWorkstationTool(definition: WorkstationToolDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered.`);
  }
  registry.set(definition.name, { kind: "workstation", definition });
  if (definition.dangerLevel !== undefined) {
    setToolPolicy(definition.name, { dangerLevel: definition.dangerLevel });
  }
}

/** Test-only: clear all registrations. Not exported from the barrel. */
export function _resetRegistryForTests(): void {
  registry.clear();
  policyRegistry.clear();
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function isWorkstationTool(name: string): boolean {
  return registry.get(name)?.kind === "workstation";
}

// ─── Building the tool list for the LLM ──────────────────────────────────────

export type ToolFilterContext = {
  allowedTools?: string[];
  deniedTools?: string[];
  predicate?: (name: string, kind: "server" | "workstation") => boolean;
  interactive?: boolean;
};

export type ToolMaterializeContext = {
  interactive: boolean;
};

export type ToolFilter = (name: string, kind: "server" | "workstation") => boolean;

export function getToolsForLLM(filter?: ToolFilter | ToolFilterContext): Tool[] {
  const ctx = normaliseFilter(filter);
  const matCtx: ToolMaterializeContext = { interactive: ctx.interactive ?? true };
  const out: Tool[] = [];
  for (const [name, t] of registry) {
    if (ctx.allowedTools !== undefined && !ctx.allowedTools.includes(name)) continue;
    if (ctx.deniedTools?.includes(name)) continue;
    if (ctx.predicate && !ctx.predicate(name, t.kind)) continue;
    out.push(materialise(t.definition, matCtx));
  }
  return out;
}

function normaliseFilter(
  filter: ToolFilter | ToolFilterContext | undefined,
): ToolFilterContext {
  if (!filter) return {};
  if (typeof filter === "function") return { predicate: filter };
  return filter;
}

function materialise(
  def: ServerToolDefinition,
  matCtx: ToolMaterializeContext,
): Tool {
  const platformNote = def.platformNotes?.[process.platform];
  const dynamicNote = def.descriptionFor?.(matCtx);
  const parts = [def.description];
  if (platformNote) parts.push(platformNote);
  if (dynamicNote) parts.push(dynamicNote);
  return {
    name: def.name,
    description: parts.join("\n\n"),
    parameters: def.parametersFor?.(matCtx) ?? def.parameters,
  };
}

/** All registered tool names. Useful for diagnostics. */
export function listToolNames(): string[] {
  return [...registry.keys()];
}

// ─── coerceArgs ───────────────────────────────────────────────────────────────

export function coerceArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = registry.get(toolName);
  if (!tool) return args;
  const props = tool.definition.parameters?.properties;
  if (!props) return args;

  const out: Record<string, unknown> = { ...args };
  for (const [key, schema] of Object.entries(props)) {
    if (!(key in out)) continue;
    out[key] = coerceValue(out[key], schema);
  }
  return out;
}

function coerceValue(value: unknown, schema: ToolParameterSchema): unknown {
  if (value === null || value === undefined) return value;

  switch (schema.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const lo = value.trim().toLowerCase();
        if (lo === "true" || lo === "1" || lo === "yes") return true;
        if (lo === "false" || lo === "0" || lo === "no") return false;
      }
      if (typeof value === "number") return value !== 0;
      return value;

    case "number":
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") return value;
        const n = Number(trimmed);
        if (!Number.isNaN(n) && Number.isFinite(n)) return n;
      }
      return value;

    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;

    case "array":
      if (Array.isArray(value)) {
        if (schema.items) return value.map((v) => coerceValue(v, schema.items!));
        return value;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              if (schema.items) return parsed.map((v) => coerceValue(v, schema.items!));
              return parsed;
            }
          } catch {
            /* fall through */
          }
        }
      }
      return value;

    case "object":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        if (!schema.properties) return value;
        const obj = value as Record<string, unknown>;
        const out2: Record<string, unknown> = { ...obj };
        for (const [k, sub] of Object.entries(schema.properties)) {
          if (k in out2) out2[k] = coerceValue(out2[k], sub);
        }
        return out2;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object") {
              return coerceValue(parsed, schema);
            }
          } catch {
            /* fall through */
          }
        }
      }
      return value;

    default:
      return value;
  }
}

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isToolHandlerResult(x: unknown): x is ToolHandlerResult {
  return (
    typeof x === "object" &&
    x !== null &&
    "content" in (x as Record<string, unknown>) &&
    typeof (x as { content: unknown }).content === "string"
  );
}

export function isLegacyServerToolResult(x: unknown): x is ServerToolResult {
  return (
    typeof x === "object" &&
    x !== null &&
    "result" in (x as Record<string, unknown>) &&
    typeof (x as { result: unknown }).result === "string"
  );
}
