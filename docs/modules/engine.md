# Engine

> `server/engine/` contains `SessionContext` and `TaskContext`, the runtime objects used by the task loop.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/engine/
  SessionContext.ts      session history, event emission, LLM-visible context
  TaskContext.ts         per-task runtime state and injected capabilities
```

## SessionContext

`SessionContext` is the only write path for conversation context. It is responsible for:

- Persisting entries through injected persistence.
- Emitting semantic events to the frontend.
- Appending LLM-visible entries to the in-memory LLM context.
- Updating existing entries during streaming.

Callers should not write entries directly to persistence or emit frontend events behind its back.

## TaskContext

`TaskContext` is built for one task run. It carries:

- Task identity and session ownership.
- Model/provider configuration.
- Tool list and tool execution callback.
- Abort signals and interjection state.
- Token counters and final-result state.
- The `SessionContext` for the owning session.

## LLM Visibility

`EntryKind` and `isLLMVisible(kind)` define which entries enter model context. This decision belongs in one place so UI-only notices never leak into the LLM prompt.

## Abort Model

huko has two abort layers:

- **Interject:** aborts the current LLM call so a new user message can be observed on the next loop iteration.
- **Stop:** aborts the whole task and any active LLM or tool work.

## Pitfalls

- Do not persist user messages from `TaskLoop.interject()`; the caller owns that write.
- Do not mutate `llmContext` directly.
- Do not make engine classes import HTTP, Socket.IO, or concrete DB clients.
- Do not put system prompts into session history.

## Verification

```bash
npm run check
npm test
```

## See Also

- [task-loop.md](./task-loop.md)
- [pipeline.md](./pipeline.md)
- [persistence.md](./persistence.md)
