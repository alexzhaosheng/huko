/**
 * server/services/index.ts
 *
 * Public surface of the services layer.
 */

export {
  TaskOrchestrator,
  type EmitterFactory,
  type OrchestratorOptions,
  type SendMessageInput,
  type SendMessageResult,
} from "./task-orchestrator.js";
