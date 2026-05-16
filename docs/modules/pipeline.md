# Pipeline

> `server/task/pipeline/` contains the task-loop substeps: LLM call, tool execution, and context management.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/task/pipeline/
  llm-call.ts           model invocation, streaming, assistant entry updates
  tool-execute.ts       tool call dispatch, result coercion, persistence
  context-manage.ts     compaction and future context maintenance
```

## `llm-call.ts`

Responsibilities:

- Build the provider request from `TaskContext`.
- Stream text deltas into the active assistant entry.
- Flush updates to persistence.
- Return a normalized turn result with content, tool calls, and usage.

Important invariant: before the turn is considered complete, all in-flight persistence flushes must settle so resume never sees a half-written turn.

## `tool-execute.ts`

Responsibilities:

- Coerce tool args from model output into declared schema shapes.
- Apply policy and availability checks.
- Dispatch server tools in-process.
- Dispatch workstation tools through the injected callback.
- Persist tool calls and tool results.
- Normalize string, legacy `ServerToolResult`, and rich `ToolHandlerResult` outputs.

## `context-manage.ts`

Responsibilities:

- Decide when compaction is needed.
- Preserve assistant ↔ tool_result pairing within each compaction unit (a unit is one user-role message OR one assistant message plus its trailing tool_results — finer than the old "user-to-user turn" so single-prompt heavy-iteration tasks can still compact).
- Inject summaries or elided markers where needed.
- Keep the LLM context under the selected model's context window.

Some compaction behavior may still be stubbed or evolving. Treat this module as the dedicated home for context maintenance.

## Pairing Constraints

Tool calls and tool results must stay paired. Compaction and resume must never leave the LLM with an assistant tool call that has no matching tool result.

## Pitfalls

- Do not run tools directly from `TaskLoop`; route through `tool-execute.ts`.
- Do not let streaming persistence writes race with compaction.
- Do not compact inside a turn in a way that breaks tool-call/result pairing.
- Do not expose raw provider response objects outside the LLM layer.

## Verification

```bash
npm run check
npm test
```

Use tests that cover empty LLM responses, multiple tool calls, aborts, and compaction boundaries.

## See Also

- [task-loop.md](./task-loop.md)
- [llm.md](./llm.md)
- [tools.md](./tools.md)
- [resume.md](./resume.md)
