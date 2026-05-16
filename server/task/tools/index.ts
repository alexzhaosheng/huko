/**
 * server/task/tools/index.ts
 *
 * Tool barrel + side-effect aggregator. Importing this module triggers
 * registration of every built-in tool. Adding a new tool: create the
 * file under ./server/, then add one `import "./..."` line below.
 */

export {
  registerServerTool,
  registerWorkstationTool,
  getTool,
  getToolPolicy,
  setToolPolicy,
  isWorkstationTool,
  getToolsForLLM,
  getToolPromptHints,
  listToolNames,
  coerceArgs,
  isToolHandlerResult,
  isLegacyServerToolResult,
  type ServerToolDefinition,
  type WorkstationToolDefinition,
  type ServerToolHandler,
  type ServerToolResult,
  type ToolHandlerResult,
  type PostReminder,
  type ToolAttachment,
  type ToolPolicyMeta,
  type ToolDangerLevel,
  type ToolFilter,
  type ToolFilterContext,
} from "./registry.js";

import "./server/message.js";
import "./server/plan.js";
import "./server/web-fetch.js";
import "./server/web-search.js";
import "./server/read-file.js";
import "./server/list-dir.js";
import "./server/glob.js";
import "./server/grep.js";
import "./server/write-file.js";
import "./server/edit-file.js";
import "./server/delete-file.js";
import "./server/move-file.js";
import "./server/bash.js";
import "./server/browser.js";
