# Persistence

> `server/persistence/` provides storage interfaces and built-in backends.

See [architecture.md](../architecture.md) for cross-module principles.

## Interfaces

huko splits persistence by scope:

| Interface | Scope | Default path |
|---|---|---|
| `InfraPersistence` | user-global provider/model/config data | `~/.huko/infra.db` |
| `SessionPersistence` | project-local sessions, tasks, and entries | `<cwd>/.huko/huko.db` |

The split keeps global provider setup separate from project history.

## Built-In Backends

- **Memory:** ephemeral, useful for tests and `--memory`.
- **SQLite infra:** durable user-global data.
- **SQLite session:** durable project-local data.

Future backends, such as Postgres, should implement the same interfaces without changing engine or task-loop code.

## Responsibilities

- Store and load sessions, tasks, entries, providers, models, and config.
- Apply migrations at construction time for SQLite backends.
- Provide typed methods for the orchestrator and CLI.
- Close resources through `close()`.

## Non-Responsibilities

- Persistence does not run task loops.
- Persistence does not render frontend events.
- Persistence does not resolve API key values.
- Persistence does not decide LLM visibility.

## API Key Rule

Persistence may store logical `api_key_ref` values. It must never store actual API key values.

## Session Entries

Session entries must preserve enough information to rebuild LLM-visible context and UI history:

- Entry kind.
- Role.
- Content.
- Tool call id.
- Thinking or streaming metadata where applicable.
- Timestamps.
- Elision state for compaction.

## Close Contract

All persistence implementations must expose `close()`. Even memory backends should implement it as a no-op so lifecycle code can be uniform.

## Pitfalls

- Do not import SQLite classes into engine or task modules.
- Do not add an env override when constructor options already support test paths.
- Do not let memory and SQLite behavior drift in ways that break tests.
- Do not persist redacted secret values back into DB as if they were real values.

## Verification

```bash
npm run check
npm test
```

Migration tests should exercise both infra and session databases.

## See Also

- [db.md](./db.md)
- [security.md](./security.md)
- [orchestrator.md](./orchestrator.md)
