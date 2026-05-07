/**
 * server/task/tools/index.ts
 *
 * Tool barrel + side-effect aggregator.
 *
 * Importing this module triggers registration of every built-in tool
 * via the `import "./xxx.js"` lines below. Tool files call
 * `registerServerTool(...)` / `registerWorkstationTool(...)` at module
 * top level, so a side-effect import is enough.
 *
 * To add a new tool: write the file under `./server/` or `./workstation/`,
 * then add one `import "./..."` line here. No other file changes.
 */

// ── Re-export the public API surface of the registry ─────────────────────────
export {
  registerServerTool,
  registerWorkstationTool,
  getTool,
  isWorkstationTool,
  getToolsForLLM,
  listToolNames,
  type ServerToolHandler,
  type ServerToolResult,
  type ToolFilter,
} from "./registry.js";

// ── Built-in tools — populated as tools land ─────────────────────────────────
// import "./server/message.js";
// import "./server/search.js";
// import "./workstation/shell.js";
// (none yet — tools are added in subsequent rounds)
