/**
 * server/core/llm/index.ts
 *
 * Public surface of the LLM layer.
 *
 * Importing this module pulls in `./register.ts` as a side-effect, which
 * registers every built-in protocol adapter. Consumers only need to
 * import from here and call `invoke(...)` — they never deal with the
 * registry directly.
 */

import "./register.js";

// Core call API
export { invoke } from "./invoke.js";

// Types
export type { ProtocolAdapter } from "./protocol.js";
export {
  getAdapter,
  listProtocols,
  registerAdapter,
} from "./protocol.js";

export type {
  Protocol,
  LLMMessage,
  Role,
  Tool,
  ToolCall,
  ToolParameterSchema,
  LLMTurnResult,
  LLMCallOptions,
  ToolCallMode,
  ThinkLevel,
  TokenUsage,
  PartialEvent,
  StreamCallback,
} from "./types.js";

// Adapters (named exports for direct use, e.g. tests)
export { openaiAdapter, LLMHttpError } from "./adapters/openai.js";

// Provider presets
export type { ProviderPreset } from "./providers/openrouter.js";
export { openrouter, withOpenRouter } from "./providers/openrouter.js";

// XML-mode helpers (rarely needed externally, but exposed for tests)
export { injectToolsAsXml, parseXmlToolCalls } from "./xml-tools.js";
