# Daemon Gateway

> `server/gateway.ts` bridges kernel events to Socket.IO clients.

See [architecture.md](../architecture.md) for cross-module principles.

## Purpose

The gateway is a transport adapter. It does not interpret agent behavior; it subscribes to kernel events and sends them to connected clients.

## Wire Contract

The preferred wire shape is a single Socket.IO event named `huko`, carrying a `HukoEvent` payload. Semantic event types live inside the payload rather than in many Socket.IO event names.

## Responsibilities

- Manage Socket.IO connection lifecycle.
- Join clients to session/task rooms when needed.
- Forward `HukoEvent` payloads.
- Keep transport concerns outside the kernel.

## Non-Responsibilities

- It does not run tools.
- It does not call LLMs.
- It does not format messages for display.
- It does not own persistence.

## Room Model

Rooms should be derived from stable identifiers such as session id or task id. Room naming belongs in the gateway layer so the kernel remains transport-agnostic.

## Pitfalls

- Do not invent transport-specific event semantics that duplicate `HukoEvent`.
- Do not send HTML or ANSI formatting through gateway payloads.
- Do not let frontend code import server internals.

## Verification

```bash
npm run check
npm test
```

Use a daemon client or Socket.IO test to assert that a task emits `huko` events.

## See Also

- [app.md](./app.md)
- [routers.md](./routers.md)
- [orchestrator.md](./orchestrator.md)
