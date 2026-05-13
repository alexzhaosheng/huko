# Task Loop

> `server/task/task-loop.ts` runs the main agent state machine.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/task/
  task-loop.ts       TaskLoop class, interject/stop, iteration budget
  resume.ts          recovery support for interrupted tasks
```

## One Iteration

1. Check abort state and iteration/tool budgets.
2. Execute a deferred tool call first if one exists.
3. Call the LLM.
4. If the user interjected, continue so the new message is visible in the next turn.
5. If tool calls exist, execute the first one and defer the rest.
6. If content exists and no tool call is needed, set `finalResult` and finish.
7. If the model returns no useful content or tool call, inject a corrective system reminder and retry within a bounded limit.
8. Run context management.

## Interject vs Stop

| Operation | Abort target | Result | Caller responsibility |
|---|---|---|---|
| `interject()` | current LLM call only | The current LLM call is interrupted and the loop continues | Append the new user message before calling |
| `stop()` | master abort | Current LLM and tool work are stopped | Mark or report task termination |

`interject()` flips a flag and aborts the current LLM call. It does not persist the user message.

## `shouldBreak`

Server tools can return `ToolHandlerResult.shouldBreak = true`. After the tool result is persisted:

1. The result is written normally.
2. The outcome returns to `TaskLoop`.
3. Deferred calls from the same LLM turn are discarded.
4. The loop exits with status `done`.

The `message` tool in `result` mode uses this path to finish a task without another LLM call.

## Single-Step Tool Execution

When a model returns multiple tool calls, huko executes one at a time and queues the rest. This costs more loop iterations, but it allows abort/interject checks between tools and keeps persistence boundaries simple.

## Limits

| Constant | Default | Result |
|---|---|---|
| `MAX_ITERATIONS` | 200 | task fails |
| `MAX_TOOL_CALLS` | 200 | task fails |
| `MAX_EMPTY_RETRIES` | 3 | task fails after repeated empty LLM turns |

Frequent limit hits indicate an upstream issue such as bad prompting, bad model config, or tool loops.

## Summary

`run()` returns a summary with status, final result, token counts, tool-call count, iteration count, and elapsed time.

## Pitfalls

- Do not persist user messages inside `interject()`.
- Do not expect `interject()` to make the LLM see the new message immediately; it only aborts the current call.
- Do not throw abort errors from tool handlers; return a structured error result.
- Do not bypass `deferredCalls` by running tool calls in parallel.

## Verification

```bash
npm run check
npm test
```

End-to-end demos should show an LLM call, a tool call, a tool result, and a final answer.

## See Also

- [engine.md](./engine.md)
- [pipeline.md](./pipeline.md)
- [tools.md](./tools.md)
- [resume.md](./resume.md)
