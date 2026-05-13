# Config

> `server/config/` centralizes user-global, project-local, and environment configuration.

See [architecture.md](../architecture.md) for cross-module principles.

## Goals

- Keep tunable values out of random modules.
- Make defaults explicit and inspectable.
- Merge layers predictably.
- Report where each effective value came from.

## Layers

Config is resolved from lowest to highest priority:

| Layer | Scope | Example |
|---|---|---|
| Built-in defaults | package | `DEFAULT_CONFIG` |
| User config | global | `~/.huko/config.json` |
| Project config | current cwd | `<cwd>/.huko/config.json` |
| Environment | process | supported `HUKO_*` overrides |
| CLI flags | current invocation | command-specific overrides |

Later layers override earlier layers.

## Current Shape

The config module owns values such as:

- Default role.
- Context compaction thresholds.
- Tool limits and timeouts.
- Model context-window hints.
- CLI defaults.
- Daemon host/port defaults where appropriate.

## Public Surface

The module should expose:

- A default config object.
- A loader that merges all layers.
- Helpers that return both value and origin where the CLI needs explanation.
- Validation for known fields.

## Design Notes

- Prefer JSON for now because the project already depends on Node and wants minimal parsing dependencies.
- Unknown fields should be rejected or clearly warned about, depending on the call path.
- Config should be boring and deterministic; no network calls and no provider discovery inside config loading.

## Pitfalls

- Do not read config ad hoc from task-loop, tools, or orchestrator.
- Do not duplicate default values in tests; import the defaults or assert through the public loader.
- Do not store API key values in config. Store only logical references.

## Verification

```bash
npm run check
npm test
huko config show
```

## See Also

- [security.md](./security.md)
- [cli.md](./cli.md)
- [orchestrator.md](./orchestrator.md)
