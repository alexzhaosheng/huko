# Orchestrator

> `server/services/` assembles persistence, roles, tools, model config, session context, and task loops.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/services/
  index.ts
  task-orchestrator.ts
```

## Responsibilities

- Create or load chat sessions.
- Resolve active session state.
- Resolve role and model configuration.
- Build `SessionContext`.
- Create task rows through persistence.
- Build `TaskContext`.
- Start `TaskLoop`.
- Route stop and interject requests.
- Cache live loops and live session contexts.

## Non-Responsibilities

- It does not expose HTTP routes directly.
- It does not speak Socket.IO directly.
- It does not render events.
- It does not execute tool handlers itself.

## Model Resolution

Model configuration comes from infra persistence and config. The orchestrator resolves:

- Provider base URL.
- API key reference and resolved key value.
- Protocol.
- Model id.
- Default think level.
- Default tool-call mode.
- Context-window hints.

If no default model is configured, user-facing CLI paths should provide concrete setup commands.

## Role and Tool Filtering

Role frontmatter can contribute tool allow/deny lists. The orchestrator turns that into `ToolFilterContext` and passes it to `getToolsForLLM()`.

## Live State

The orchestrator keeps process-local maps for live sessions and running loops. Persistence remains the source of truth across process restarts.

## Pitfalls

- Do not bypass `SessionContext` for entry writes.
- Do not let routers duplicate orchestration logic.
- Do not store API key values in task rows.
- Do not make per-role tool filtering mutate the global registry.

## Verification

```bash
npm run check
npm test
```

End-to-end demos should create a session, send a message, and observe task completion.

## See Also

- [engine.md](./engine.md)
- [task-loop.md](./task-loop.md)
- [persistence.md](./persistence.md)
- [tools.md](./tools.md)
