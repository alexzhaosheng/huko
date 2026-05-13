# CLI

> `server/cli/` implements the command-line frontend.

See [architecture.md](../architecture.md) for cross-module principles.

## Goals

- Make huko usable as a Unix-friendly command.
- Keep stdout useful for piping and stderr useful for diagnostics.
- Support project-local state through `<cwd>/.huko/`.
- Keep one-shot, background, and interactive modes on the same kernel concepts.

## Main Commands

| Command | Purpose |
|---|---|
| `huko -- "prompt"` | One-shot run using the active session by default |
| `huko run -- "prompt"` | Explicit one-shot run |
| `huko sessions list` | Show project sessions |
| `huko sessions current` | Show active session for the cwd |
| `huko sessions switch <id>` | Set active session |
| `huko sessions new` | Create a new session |
| `huko provider ...` | Manage providers |
| `huko model ...` | Manage models |
| `huko keys ...` | Manage local key references |
| `huko config show` | Inspect effective config |
| `huko docker run -- "prompt"` | Run inside the Docker image |

Background daemon and interactive chat modes are planned.

## Output Modes

The CLI should support:

- Human text for normal terminal use.
- `jsonl` for event-stream consumers.
- `json` for structured one-shot output.

stdout should carry the answer or structured output. stderr should carry diagnostics, progress that is not part of the answer, and actionable setup guidance.

## Active Session

Each project directory can have an active session recorded in `<cwd>/.huko/state.json`. Running `huko -- "prompt"` continues that session unless the user requests a new or memory-only run.

## Memory Mode

`--memory` uses in-memory persistence. It is useful for one-off questions and tests where no project files should be written.

## Provider and Model Setup

The CLI owns user-facing setup flows:

- Add a provider with a base URL, protocol, and API key reference.
- Add models under providers.
- Mark a default model.
- Store key values in `keys.json` or resolve them from env.

Errors should include concrete next commands when setup is incomplete.

## Docker Wrapper

`huko docker run` preserves the normal CLI contract while mounting project and global huko state into the container. See [docker.md](../docker.md).

## Pitfalls

- Do not print diagnostics to stdout in pipe-friendly modes.
- Do not expose raw API key values in CLI output.
- Do not make CLI formatters depend on Socket.IO.
- Do not duplicate orchestrator logic; call the kernel or daemon API.
- Do not write project-local state outside `<cwd>/.huko/`.

## Verification

```bash
npm run check
npm test
huko --help
```

CLI tests should cover stdin piping, exit codes, JSON output, and Windows command behavior.

## See Also

- [config.md](./config.md)
- [security.md](./security.md)
- [persistence.md](./persistence.md)
- [docker.md](../docker.md)
