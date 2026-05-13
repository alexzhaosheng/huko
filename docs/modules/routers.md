# Daemon Routers

> `server/routers/` exposes daemon control operations through tRPC.

See [architecture.md](../architecture.md) for cross-module principles.

## Purpose

Routers are a transport-level API for daemon clients. They should be thin wrappers around orchestrator and persistence operations.

## Responsibilities

- Accept validated client input.
- Call orchestrator methods.
- Expose session, task, provider, and model control operations where daemon mode needs them.
- Return structured data that clients can render.

## Non-Responsibilities

- Routers do not run task loops directly.
- Routers do not write session entries directly.
- Routers do not format CLI or web output.
- Routers do not resolve provider-specific LLM behavior.

## Input Validation

Use explicit schemas for router inputs. Keep validation close to the router boundary so internal modules can receive typed values.

## Relationship to CLI

The CLI can either call kernel APIs directly for one-shot mode or talk to the daemon through tRPC for background mode. Router contracts should therefore stay stable and structured.

## Pitfalls

- Do not duplicate orchestrator logic in routers.
- Do not expose secrets in router responses.
- Do not make router output depend on a specific frontend presentation.
- Do not let route names become the semantic event protocol; that belongs to `HukoEvent`.

## Verification

```bash
npm run check
npm test
```

Router tests should validate input errors and orchestrator call behavior.

## See Also

- [app.md](./app.md)
- [gateway.md](./gateway.md)
- [orchestrator.md](./orchestrator.md)
