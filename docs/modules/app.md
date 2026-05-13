# App Bootstrap

> `server/core/app.ts` wires Express, tRPC, Socket.IO, and persistence for the daemon process.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/core/app.ts        daemon bootstrap
server/routers/           tRPC control API
server/gateway.ts         Socket.IO gateway
server/persistence/       infra and session persistence implementations
```

## Responsibilities

- Load configuration from the unified config subsystem.
- Create infra persistence for user-global data.
- Create session persistence for the current project directory.
- Run needed migrations through the selected persistence backend.
- Build `TaskOrchestrator` with persistence, config, and an event emitter.
- Mount the tRPC API under `/api/trpc`.
- Mount the Socket.IO gateway and stream `HukoEvent` payloads to connected clients.
- Expose lightweight health endpoints for local development and smoke tests.

## Non-Responsibilities

- It does not contain task-loop logic.
- It does not know how tools execute.
- It does not render events.
- It does not store API key values in DB.

## Environment

| Variable | Meaning |
|---|---|
| `PORT` | HTTP server port |
| `HOST` | HTTP server host |
| `HUKO_CONFIG_*` | Optional config overrides, where supported by the config module |

## Lifecycle

1. Resolve config.
2. Open infra persistence.
3. Open project session persistence.
4. Build orchestrator.
5. Register HTTP and WebSocket surfaces.
6. Start listening.
7. On shutdown, close persistence and the HTTP server.

## Pitfalls

- Do not import frontend code here.
- Do not hardcode tunable values here when the config subsystem can own them.
- Do not bypass persistence interfaces by importing concrete DB schema from the bootstrap.
- Keep startup side effects explicit and easy to audit.

## Verification

```bash
npm run check
npm run dev
```

Then hit the health endpoint or connect a daemon client.

## See Also

- [routers.md](./routers.md)
- [gateway.md](./gateway.md)
- [persistence.md](./persistence.md)
- [config.md](./config.md)
