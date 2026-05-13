# huko Architecture Overview

> huko is a **lightweight, embeddable, customizable agent kernel**. It is not a chat app and not a web product.
>
> It is meant to be a building block for shell scripts, CI, Make, git hooks, IDE plugins, and automation workflows.
>
> New sessions should read this document first, then open module documents as needed.
>
> **Keep this document concise**. It should cover cross-module principles and the module index. Module-specific design belongs in `modules/<name>.md`.

---

## 1. Positioning

huko is shaped as **a kernel plus pluggable extensions**:

```text
+----------------------------------------+
|              Frontends                 |
| -------------------------------------- |
|   One-shot CLI      `huko ...`         |
|   Background CLI    `huko start/send`  |
|   Interactive CLI   `huko chat`        |
|   External web UI   separate package   |
|   IDE plugins       same event stream  |
+----------------------------------------+
              ^ semantic events (HukoEvent)
              v control API (tRPC / direct API)
+----------------------------------------+
|              huko kernel               |
| -------------------------------------- |
|   TaskOrchestrator                     |
|   TaskLoop / pipeline                  |
|   SessionContext / TaskContext         |
|   LLM protocol adapters                |
|   Tool registry                        |
+----------------------------------------+
              ^ interface injection
              v implementation
+----------------------------------------+
|          Pluggable extensions          |
| -------------------------------------- |
|   Persistence: null / file / sqlite    |
|                + external backends     |
|   Tools: builtin / npm plugin / ad-hoc |
|   Skills: same idea, future work       |
|   Frontends: listed above              |
+----------------------------------------+
```

**Core design commitments:**

- The kernel **does not assume a UI**. All output is a semantic event stream (`HukoEvent`), and rendering is owned by the consumer.
- The kernel **does not assume persistence**. Persistence is injected through interfaces, with null/file/sqlite built in and external backends allowed.
- The kernel **does not bind to one frontend**. The HTTP daemon, one-shot CLI, and background CLI are all kernel consumers.
- Tools and skills can be injected at **runtime** without changing the main repository.

---

## 2. Principles

These are cross-module contracts. Read them before designing a new module.

### Boundaries and Dependencies

- **The kernel assumes no infrastructure.** `server/engine/`, `server/task/`, and `server/services/` must not directly import HTTP libraries, Socket.IO, concrete database clients, or UI frameworks. Infrastructure is injected through constructors.
- **Frontends are not imported back into the kernel.** The kernel exposes events and APIs; frontends such as CLI, daemon HTTP, external web, and IDE plugins call the kernel. The reverse direction is not allowed.
- **Persistence goes through `InfraPersistence` and `SessionPersistence`.** The split is by scope:
  - `InfraPersistence` stores providers, models, and user-global defaults in `~/.huko/infra.db`.
  - `SessionPersistence` stores sessions, tasks, and entries in `<cwd>/.huko/huko.db`.
  - The kernel must not directly import drizzle or better-sqlite3.
- **API keys never enter the database.** `providers.api_key_ref` is a logical name. At runtime, `server/security/keys.ts` resolves it through four layers (highest first): `<cwd>/.huko/keys.json`, `~/.huko/keys.json`, `process.env.<REF_UPPER>_API_KEY`, then `<cwd>/.env`.

### Context Writes

- **`SessionContext` is the only entry point for context writes.** Code that bypasses it to write persistence or push events directly is a bug.
- **`isLLMVisible(kind)` is the single decision point for which entries enter LLM context.** Callers do not pass dispatch flags.
- **System prompts are not stored in sessions.** They are task-level configuration assembled by the pipeline at LLM-call time.

### Output Protocol

- **`HukoEvent` is the single kernel-to-frontend protocol.** Everything that "happened" is represented by this protocol, without embedding presentation formatting.
- Events use **semantic types**, not loose strings: `assistant_text_delta`, `tool_call`, `ask_user`, `task_terminated`, and so on.
- Frontends such as the CLI text formatter, CLI JSON output, external web UI, and IDE plugins are different consumers of `HukoEvent`.
- **Never put HTML, ANSI, or JSON strings inside event payloads.** Payloads are structured data.

### Registration and Extension

- **Use explicit side-effect registration.** Protocol adapters and built-in tools are registered through centralized imports such as `register.ts` and `tools/index.ts`. Do not rely on hidden top-level registration scattered across modules.
- **Public functions that depend on registries must import the registrar themselves.** For example, `invoke()` imports `./register.js`, and `TaskOrchestrator` imports `../task/tools/index.js`.
- **Before adding a feature, decide whether it is a dispatch point or a factory helper.** Dispatch points belong in registries; factory helpers are named convenience wrappers.
- **Pluggable boundaries are `Persistence`, `Tool`, `Skill`, and `Frontend`.** Each boundary has:
  1. An interface or contract defined inside the kernel.
  2. A minimal built-in default implementation, such as null/file/sqlite or message/echo.
  3. External implementations provided by npm packages or ad-hoc injection.

### Experience and Persistence

- **Streaming is first-class.** For large-model workflows, streaming is the experience. The kernel emits token-level events.
- **SQLite is the default persistence backend** for the common case, while each frontend may choose null, file, or an external backend.
- **Zero-write operation must stay available.** The CLI `--memory` ephemeral mode is a core use case.

### Code Conventions

- **ESM with explicit `.js` suffixes.** All relative imports use `from "./xxx.js"`, even when the source file is TypeScript.
- **Strict TypeScript.** Use `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`.
  - Do not put `undefined` into optional fields. Use conditional spreading such as `...(x !== undefined ? { x } : {})`.
  - Array indexing returns `T | undefined`; use optional chaining or explicit guards.
  - `process.env["KEY"]` is always `string | undefined`; use `?? "default"` where a fallback is required.
- **No god files.** One file should have one responsibility. If a file grows past roughly 300 lines, consider whether it should be split. The same rule applies to design documents.
- **No DOM in the kernel.** The kernel `tsconfig` must not include DOM libs. Kernel code should not be able to compile references to `document` or `window`.

---

## 3. Module Index

`OK` means implemented and documented. `Needs rewrite` means implemented but the document is stale. `Pending` means not implemented.

| Module | Path | Design doc | Summary | Status |
|---|---|---|---|---|
| Shared types | `shared/` | See [engine](./modules/engine.md) | EntryKind / TaskStatus / llm-protocol / **HukoEvent** | OK |
| LLM call layer | `server/core/llm/` | [llm](./modules/llm.md) | Protocol adapters, streaming, and both tool-call modes | OK |
| Engine | `server/engine/` | [engine](./modules/engine.md) | SessionContext + TaskContext | OK |
| Task Loop | `server/task/task-loop.ts` | [task-loop](./modules/task-loop.md) | Main state machine, interject, and stop | OK |
| Pipeline | `server/task/pipeline/` | [pipeline](./modules/pipeline.md) | llm-call + tool-execute + context-manage | OK + pending stub |
| Tools | `server/task/tools/` | [tools](./modules/tools.md) | Dual registration, ToolHandlerResult, coerceArgs, policy; built-in message + web_fetch | OK |
| Config | `server/config/` | [config](./modules/config.md) | One config subsystem: DEFAULT_CONFIG + `~/.huko/config.json` + project + env. All tunable hardcoded values end here | OK |
| Resume | `server/task/resume.ts` | [resume](./modules/resume.md) | Orphan recovery: mark failed, synthesize paired tool_result, filter elided entries | OK |
| Persistence | `server/persistence/` | [persistence](./modules/persistence.md) | Two interfaces: InfraPersistence and SessionPersistence; sqlite + memory backends | OK |
| DB schema | `server/db/` | [db](./modules/db.md) | Two SQLite schemas: `schema/infra.ts` and `schema/session.ts`, each with migrations | OK |
| Security | `server/security/` | [security](./modules/security.md) | API key resolution from `<cwd>/.huko/keys.json`, env, then `<cwd>/.env`; DB never stores keys | OK |
| Orchestrator | `server/services/` | [orchestrator](./modules/orchestrator.md) | Kernel assembly point, now wired through persistence | OK |
| Daemon Gateway | `server/gateway.ts` | [gateway](./modules/gateway.md) | Socket.IO gateway plus a single `huko` wire event | OK |
| Daemon Routers | `server/routers/` | [routers](./modules/routers.md) | tRPC control API for daemon use only | OK |
| Daemon Bootstrap | `server/core/app.ts` | [app](./modules/app.md) | Express + WS + tRPC assembly | OK |
| HukoEvent protocol | `shared/events.ts` | Dedicated doc pending | Semantic event discriminated union with 11 event types | OK |
| CLI | `server/cli/` | [cli](./modules/cli.md) | `run`, `sessions`, `provider`, `model`, `keys`, `config`; background and interactive modes are pending | OK (v1) |
| Workstation | `server/workstation-manager/` | Not written | Local-machine integration | Pending |
| ~~Web Client~~ | ~~`client/`~~ | Extracted | Moved to a separate repository/package | Removed |

---

## 4. Related Documents

- `info.md` records the WeavesAI analysis and the design rationale behind huko.
- `architecture.md` is this document: principles and module index.
- `modules/*.md` contains detailed design notes for each module.

---

## 5. New-Session Workflow

1. Read this document and build the mental model: principles plus module map.
2. Open the relevant `modules/<name>.md` documents for the task at hand.
3. For cross-module work, load each related module document.
4. When changing one module's design, edit only that module's document to avoid cascading documentation churn.

---

## 6. New Module and Extension Protocol

- **New kernel module:** implement the code, create `modules/<name>.md`, and add a row to this index.
- **New built-in persistence backend:** place it under `server/persistence/<name>/` and implement the persistence interface.
- **New built-in tool:** place it under `server/task/tools/<server|workstation>/<name>.ts` and call the appropriate `registerXxxTool`.
- **New `HukoEvent` type:** add it to the union in `shared/events.ts`, then update each frontend renderer.
- **New frontend** such as a CLI subcommand, external web UI, or IDE plugin: consume `HukoEvent` and call tRPC. Do not modify the kernel for frontend presentation.

Documents and code should be reviewed and merged together.

---

## 7. Current Progress

**Implemented: kernel is basically runnable**

- LLM protocol adaptation: OpenAI protocol plus OpenRouter preset.
- Engine: SessionContext three-way flow, TaskContext, and two-level abort handling.
- TaskLoop and pipeline: llm-call, tool-execute, and a context-manage stub.
- Tool registration system with two entry points.
- SQLite persistence, now moving toward the persistence abstraction.
- Daemon HTTP/WS assembly, currently temporary until fully upgraded to the HukoEvent protocol.

**Current iteration**

Reference: [agent-design-notes.md](./agent-design-notes.md).

The current iteration is complete: Promise.race audit, SystemReminder collector, pairing constraints, turn-atomic compaction, and three resume checkpoints.

**Recently completed**

- ~~Extracted the web client from the main repository.~~
- ~~Persistence interface abstraction with Memory and SQLite built-ins.~~
- ~~Decoupled Orchestrator and routers from DB and wired them through Persistence.~~
- ~~Formalized the HukoEvent semantic event protocol.~~
- ~~One-shot CLI mode with text, jsonl, and json formatters.~~
- ~~Retired FilePersistence after the split.~~
- ~~Tool system v2: ToolHandlerResult, coerceArgs, display, dangerLevel, and platformNotes.~~
- ~~First built-in server tools: `message` with info/result and `web_fetch`.~~
- ~~CLI `sessions list/delete`, `--memory`, and `--title`.~~
- ~~Moved `runMigrations()` into the SqlitePersistence constructor.~~
- ~~Made `Persistence.close()` required.~~
- ~~Added the "solve from the root" principle to CLAUDE.md.~~
- ~~WeavesAI design research document: [agent-design-notes.md](./agent-design-notes.md).~~
- ~~Split persistence into `InfraPersistence` and `SessionPersistence`.~~
- ~~Decoupled API keys through `providers.api_key_ref` and the layered lookup in `server/security/keys.ts` (now four layers including `~/.huko/keys.json`).~~
- ~~Added active session per cwd through `<cwd>/.huko/state.json`, default continuation, and `sessions current/switch/new`.~~
- ~~Completed provider/model/keys CLI CRUD.~~
- ~~Auto-generated `<cwd>/.huko/.gitignore` for `huko.db`, `keys.json`, and `state.json`.~~
- ~~Removed the unused `HUKO_DB_PATH` env override.~~

**Next work**

- More built-in server tools such as `fs_read`, `fs_write`, and `search`.
- Background CLI mode: `huko start` launches a detached daemon and `huko send` uses the tRPC client.
- Interactive CLI mode: `huko chat` with a readline send loop.
- Tool plugin loading through npm conventions and ad-hoc injection.
- Skills system: contextual instruction packs the LLM can activate.
- Workstation integration.
