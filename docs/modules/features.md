# Features

> `server/services/features/` provides a registry for opt-in feature bundles —
> coordinated groups of tools and/or chat-mode sidecar services that share a
> single on/off knob.

See [architecture.md](../architecture.md) for cross-module principles.

## Concept

A **Feature** is a bundle that can include:

- A set of agent tools (marked by their `feature` tag in the tool registry)
- An optional **Sidecar**: a long-lived service spawned in chat mode

One enable/disable decision controls both at once. When a feature is enabled,
its tools become visible to the LLM AND its sidecar starts (in chat mode).
When disabled, neither.

Three common shapes:

- **Tool-only feature** — heavyweight tools you do not always want occupying
  the LLM's context window.
- **Tool + sidecar feature** — agent tools that drive an external service the
  sidecar hosts.
- **Sidecar-only feature** — a service with no LLM-facing tool surface.

The point of the bundle abstraction is that one decision toggles both halves
together — no risk of "sidecar running but tools hidden" or vice versa.

## Files

```text
server/services/features/
  registry.ts   Feature / Sidecar / SidecarDeps / FeaturesConfig types,
                registerFeature, getFeature, listFeatures,
                computeEnabledFeatures, assertNoNameCollisionsWithTools
  sidecars.ts   startEnabledSidecars (chat-mode entry), stopAllSidecars
  index.ts      barrel
```

## Defining a Feature

Register at module load time via side-effect import — the same pattern as
tools (`server/task/tools/index.ts`). When the first feature ships, expect a
companion side-effect manifest analogous to that tools index.

```ts
import { registerFeature } from "../../services/features/index.js";

registerFeature({
  name: "browser",
  enabledByDefault: false,
  sidecar: {
    async start(deps) {
      // Bind your port, wire your protocol, hand back when ready.
    },
    async stop() {
      // Release everything start() acquired. Idempotent.
    },
  },
});
```

`enabledByDefault` choice:

- `false` for any feature with non-trivial setup cost the operator should opt
  in to (binding a port, spawning a child process, large tool descriptions).
- `true` only for features that belong in the "default huko experience" —
  rare; if in doubt, ship false.

A feature without a `sidecar` is valid (pure tool group). A feature without
any tagged tools is valid (pure service).

## Tagging Tools

Tool definitions accept an optional `feature` field. When the feature is
disabled, the tool is filtered out of `getToolsForLLM` and
`getToolPromptHints` — it never reaches the LLM, so it costs zero context
tokens.

```ts
registerServerTool(
  {
    name: "browser_navigate",
    feature: "browser",
    description: "...",
    parameters: { ... },
    dangerLevel: "moderate",
  },
  async (args, ctx) => { ... },
);
```

Tools without a `feature` tag are unaffected by the bundle system. They
follow the existing `safety.toolRules.<name>.disabled` rules unchanged.

Safety remains the final gate: a feature being enabled does NOT override a
`safety.toolRules.<tool>.disabled = true`. The two axes compose — safety is
the floor, feature gating is the visibility filter on top.

## Sidecar Contract

A sidecar is a long-lived service. The infrastructure guarantees:

- `start(deps)` is called once, when the feature is enabled and chat mode
  boots, after persistence and orchestrator are ready.
- `stop()` is called once, on chat exit, BEFORE persistence shuts down — so
  the sidecar can flush any final state through the live session.
- A `start()` error is captured and surfaced to stderr in yellow, but does
  **not** block chat from starting. Graceful degradation is the default.
- A `stop()` error is logged and swallowed (shutdown can't fail usefully).

`SidecarDeps` currently exposes only `projectRoot: string`. Sidecars that
need more from the kernel (event emitter, session handle, orchestrator)
should propose specific additions. Resist the urge to widen `SidecarDeps`
into a god-object — concrete needs only.

### Lifecycle invariants

- **Chat-only.** `startEnabledSidecars` is called exclusively from
  `server/cli/commands/chat.ts`. One-shot `huko -- prompt` never spawns
  sidecars. A sidecar therefore never needs to ask "am I in chat mode?" —
  by construction, yes.
- **One sidecar per feature per chat process.** Per-project / per-machine
  singletons (e.g. binding a fixed port first-come-first-served across N
  huko processes) are the sidecar's own responsibility. Fail the start
  with a clear message and chat continues without that sidecar.

## Configuration

Per-user / per-project / per-invocation layered, identical to every other
huko config field:

```jsonc
// ~/.huko/config.json or <cwd>/.huko/config.json
{
  "features": {
    "browser": { "enabled": true }
  }
}
```

CLI flags `--enable=<name>` / `--disable=<name>` apply to a single invocation
as the highest-priority layer (loadConfig's `explicit` slot). Same-name in
both flag forms is rejected at parse time. Both flags work in one-shot
(`huko -- ...`) and chat (`huko --chat`) modes — they control tool
visibility everywhere; sidecars only spawn in chat.

A feature mentioned nowhere — no config, no flag — falls back to its
declared `enabledByDefault`.

## Naming

Tool names and feature names share a single namespace. Bootstrap calls
`assertNoNameCollisionsWithTools(listToolNames())`; a collision is fatal.
The reason: `--enable=X` / `--disable=X` must resolve unambiguously to
one thing. If a feature would naturally share a tool's name, rename one.

## Pitfalls

- **Do not** query "am I in chat mode" from inside a sidecar. By
  construction you only run there; encoding the check duplicates a
  structural truth and rots when the constraint shifts.
- **Do not** throw from `start()` to abort chat. Chat will continue
  without your sidecar and report the error — that's the desired
  graceful degradation.
- **Do not** add token / protocol / port primitives to `SidecarDeps`.
  Different sidecars speak different protocols; the base infrastructure
  stays neutral. Token bootstrap, transport choice, auth — all live
  inside the sidecar's own implementation.
- **Do not** ship features with `enabledByDefault: true` lightly. Each
  default-on feature pays its tool-description tokens in every chat;
  the whole point of the bundle system is to escape that tax.
- **Do not** assume `setEnabledFeatures()` is dynamic during a chat —
  bootstrap calls it once after computing the enabled set. Mid-chat
  enable / disable is not currently supported.

## Verification

```bash
npx tsc --noEmit
```

There is no automated test suite for the feature subsystem yet. Smoke
verify by registering a temporary feature, tagging a tool against it, and
toggling via `--enable=<name>` / `--disable=<name>`.

## See Also

- [tools.md](./tools.md)
- [config.md](./config.md)
- [cli.md](./cli.md)
