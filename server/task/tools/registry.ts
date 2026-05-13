/**
 * server/task/tools/registry.ts
 *
 * Tool registry. Two registration entry points:
 *   - registerServerTool(def, handler) — runs in-process
 *   - registerWorkstationTool(def)     — dispatched via ctx.executeTool
 *
 * Tool files self-register at module load time via tools/index.ts side-
 * effect imports. Adding a new tool is a one-file change.
 */

import type { Tool, ToolParameterSchema } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";
import { getConfig } from "../../config/index.js";

// ─── ToolHandlerResult ────────────────────────────────────────────────────────

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

export type PostReminder = {
  reason: string;
  content: string;
};

export type ToolAttachment = {
  filename: string;
  mimeType: string;
  size?: number;
  path: string;
};

export type ToolCallMeta = {
  toolCallId: string;
};

export type ServerToolHandler = (
  args: Record<string, unknown>,
  ctx: TaskContext,
  callMeta?: ToolCallMeta,
) => Promise<string | ServerToolResult | ToolHandlerResult>
  | string
  | ServerToolResult
  | ToolHandlerResult;

export type ServerToolResult = {
  result: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

// ─── Tool definition (v2) ────────────────────────────────────────────────────

export type ServerToolDefinition = Tool & {
  platformNotes?: Partial<Record<NodeJS.Platform, string>>;
  dangerLevel?: ToolDangerLevel;
  parametersFor?: (ctx: ToolMaterializeContext) => Tool["parameters"];
  descriptionFor?: (ctx: ToolMaterializeContext) => string | undefined;
  /**
   * Optional system-prompt guidance contributed by this tool, spliced
   * into the <tool_use> block at build time. Use sparingly — only when
   * the rule is about INTER-TOOL coordination or workflow that doesn't
   * fit in this tool's `description`. Single-tool usage rules belong
   * in `description`.
   *
   * Hints from filtered-out tools are NOT included, so a role that
   * disables a tool also drops its prompt guidance automatically.
   */
  promptHint?: string;
  /**
   * Lean-mode replacement for `description`. When the tool is rendered
   * via lean mode (`ToolMaterializeContext.lean === true`), this string
   * is sent to the LLM in place of `description`. Default mode is
   * unaffected.
   *
   * The two descriptions are SEPARATE fields on purpose — touching one
   * cannot bleed into the other's rendering path (see materialise()).
   * Omit to fall back to `description` (i.e. lean mode picks up the full
   * description unchanged).
   *
   * Use when a tool's full description carries guidance the lean-mode
   * user case won't exercise (e.g. bash's `send`/`wait`/`kill`/`view`
   * advanced workflows). A slim variant keeps lean fast without
   * degrading default-mode reliability.
   */
  leanDescription?: string;
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

export type RegisteredTool =
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
  /**
   * Render tools for lean mode. When true, `materialise()` uses each
   * tool's `leanDescription` (falling back to `description` when unset)
   * and skips default-mode rendering hooks (`platformNotes`,
   * `descriptionFor`, `parametersFor`). Default false.
   */
  lean?: boolean;
};

export type ToolMaterializeContext = {
  interactive: boolean;
  lean: boolean;
};

export type ToolFilter = (name: string, kind: "server" | "workstation") => boolean;

export function getToolsForLLM(filter?: ToolFilter | ToolFilterContext): Tool[] {
  const ctx = normaliseFilter(filter);
  const matCtx: ToolMaterializeContext = {
    interactive: ctx.interactive ?? true,
    lean: ctx.lean ?? false,
  };
  const safetyDisabled = collectSafetyDisabledTools();
  const out: Tool[] = [];
  for (const [name, t] of registry) {
    if (ctx.allowedTools !== undefined && !ctx.allowedTools.includes(name)) continue;
    if (ctx.deniedTools?.includes(name)) continue;
    if (ctx.predicate && !ctx.predicate(name, t.kind)) continue;
    // Per-tool `disabled: true` in the merged safety config removes the
    // tool from the LLM's surface entirely — both full and lean modes,
    // both server and workstation tools. Stronger than `deny` patterns
    // (which still expose the tool to the LLM and refuse at execution).
    if (safetyDisabled.has(name)) continue;
    out.push(materialise(t.definition, matCtx));
  }
  return out;
}

/**
 * Pull the set of tool names whose merged safety config has
 * `disabled: true`. `getConfig()` self-loads on first access so this
 * works whether or not bootstrap has run — no fail-open guard, no
 * "config not loaded" surprise.
 */
function collectSafetyDisabledTools(): Set<string> {
  const out = new Set<string>();
  const rules = getConfig().safety.toolRules;
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.disabled === true) out.add(name);
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
  // Two completely separate rendering paths — touching one cannot leak
  // into the other (mirrors the buildSystemPrompt / buildLeanSystemPrompt
  // split). Lean does NOT call platformNotes / descriptionFor /
  // parametersFor; those are default-mode rendering hooks by design.
  return matCtx.lean
    ? materialiseLean(def)
    : materialiseDefault(def, matCtx);
}

function materialiseLean(def: ServerToolDefinition): Tool {
  return {
    name: def.name,
    description: def.leanDescription ?? def.description,
    parameters: def.parameters,
  };
}

function materialiseDefault(
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

/**
 * Heuristic: a tool is "writable" (i.e. has external-facing side effects
 * worth gating with a safety prompt) if its dangerLevel is moderate or
 * dangerous. Safe tools (read_file / list_dir / grep / glob / web_fetch /
 * web_search) fall through to byDangerLevel.safe and don't need rule stubs
 * in the safety scaffold.
 */
export function isWritableTool(def: ServerToolDefinition): boolean {
  return def.dangerLevel === "moderate" || def.dangerLevel === "dangerous";
}

/**
 * Collect promptHint strings from every tool that survives the same
 * filter applied to getToolsForLLM. Returns hints in registration
 * order (matches import order in tools/index.ts).
 */
export function getToolPromptHints(
  filter?: ToolFilter | ToolFilterContext,
): string[] {
  const ctx = normaliseFilter(filter);
  const out: string[] = [];
  for (const [name, t] of registry) {
    if (ctx.allowedTools !== undefined && !ctx.allowedTools.includes(name)) continue;
    if (ctx.deniedTools?.includes(name)) continue;
    if (ctx.predicate && !ctx.predicate(name, t.kind)) continue;
    const hint = t.definition.promptHint;
    if (hint && hint.trim().length > 0) {
      out.push(hint.trim());
    }
  }
  return out;
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
