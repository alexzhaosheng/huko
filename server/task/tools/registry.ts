/**
 * server/task/tools/registry.ts
 *
 * The single tool registry.
 *
 * Two explicit registration entry points so intent is impossible to miss:
 *   - `registerServerTool(def, handler)`     — runs in-process on the server
 *   - `registerWorkstationTool(def)`         — dispatched to the user's local
 *                                              machine via the executeTool
 *                                              callback on TaskContext
 *
 * Tool files self-register at module load time. `tools/index.ts` does
 * side-effect imports of every tool file; importing `tools/index.ts`
 * once at TaskLoop startup populates the registry.
 *
 * `getToolsForLLM(filter)` builds the tool list passed to the LLM. The
 * pipeline caches a `filterKey` derived from the active filter so the
 * tool array is only rebuilt when something changed — this keeps the
 * provider's prompt cache hot.
 */

import type { Tool } from "../../core/llm/types.js";
import type { TaskContext } from "../../engine/TaskContext.js";

// ─── Handler types ────────────────────────────────────────────────────────────

/**
 * A server tool handler. Runs in the same process as TaskLoop.
 *
 * Returns either:
 *   - a string (the tool result, success path), or
 *   - { result, error } (explicit error reporting).
 *
 * Throwing is also fine — `executeAndPersist` will catch and convert to
 * an error result.
 */
export type ServerToolHandler = (
  args: Record<string, unknown>,
  ctx: TaskContext,
) => Promise<string | ServerToolResult> | string | ServerToolResult;

export type ServerToolResult = {
  result: string;
  error?: string | null;
  /** Optional metadata attached to the resulting `tool_result` entry. */
  metadata?: Record<string, unknown>;
};

// ─── Internal registry shape ──────────────────────────────────────────────────

type RegisteredTool =
  | { kind: "server"; definition: Tool; handler: ServerToolHandler }
  | { kind: "workstation"; definition: Tool };

const registry = new Map<string, RegisteredTool>();

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerServerTool(definition: Tool, handler: ServerToolHandler): void {
  if (registry.has(definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered.`);
  }
  registry.set(definition.name, { kind: "server", definition, handler });
}

export function registerWorkstationTool(definition: Tool): void {
  if (registry.has(definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered.`);
  }
  registry.set(definition.name, { kind: "workstation", definition });
}

/** Test-only: clear all registrations. Not exported from the barrel. */
export function _resetRegistryForTests(): void {
  registry.clear();
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function isWorkstationTool(name: string): boolean {
  return registry.get(name)?.kind === "workstation";
}

// ─── Building the tool list for the LLM ──────────────────────────────────────

/**
 * Predicate for filtering which tools are exposed to the LLM in the
 * current state. Returning `false` hides the tool. Returning `true`
 * (or no filter) exposes it.
 */
export type ToolFilter = (name: string, kind: "server" | "workstation") => boolean;

/**
 * Build the tool definition list passed to the LLM. Pure — same input
 * always produces same output, so the pipeline can memoize on a
 * filterKey to skip rebuilds.
 */
export function getToolsForLLM(filter?: ToolFilter): Tool[] {
  const out: Tool[] = [];
  for (const [name, t] of registry) {
    if (!filter || filter(name, t.kind)) out.push(t.definition);
  }
  return out;
}

/** All registered tool names. Useful for diagnostics. */
export function listToolNames(): string[] {
  return [...registry.keys()];
}
