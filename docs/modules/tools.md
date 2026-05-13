# Tools

> `server/task/tools/` defines tool registration, runtime argument coercion, tool policy metadata, and built-in tools.

See [architecture.md](../architecture.md) for cross-module principles.

## Files

```text
server/task/tools/
  registry.ts            dual registration, ToolHandlerResult, coercion
  index.ts               side-effect imports for built-in tools
  server/
    message.ts           user-facing message tool
    web-fetch.ts         HTTP GET tool
  workstation/           future workstation tools
```

## Two Registration Entry Points

Server tools run in the Node process:

```ts
registerServerTool(definition, async (args, ctx) => {
  return "result";
});
```

Workstation tools are routed to the user's local machine:

```ts
registerWorkstationTool(definition);
```

The two functions are mutually exclusive. Registering the same tool name twice throws. Workstation tools do not have in-process handlers; execution goes through the injected `ctx.executeTool` callback.

## Why Not One `registerTool` Flag

Separate functions make the dispatch path visible in the code and type system:

- Server tools must provide a handler.
- Workstation tools must not provide a handler.
- Tool authors choose the execution location when writing the tool file.

## `ToolHandlerResult`

Server tool handlers can return three shapes, from simplest to richest:

```ts
// 1. Simple string: directly used as tool result content
return "done";

// 2. Legacy/simple result object
return { result: "done", error: null };

// 3. Rich semantic result
return {
  content: "LLM-visible result",
  finalResult: "user-visible final answer",
  shouldBreak: true,
  summary: "short UI summary",
  attachments: [],
  error: null,
};
```

`shouldBreak` means that after the current tool result is persisted, `TaskLoop` exits cleanly with status `done`. No extra LLM call is made, and deferred calls from the same turn are discarded.

`finalResult` writes to `ctx.finalResult` and marks that the task has an explicit result. It is commonly paired with `shouldBreak`, though future agent-style subtasks may set it without ending the parent loop.

## Argument Coercion

LLMs sometimes return `"true"` for booleans, JSON strings for arrays/objects, or numeric strings such as `"5"`. `tool-execute.ts` calls `coerceArgs(name, args)` before dispatch.

| Schema type | Accepted input |
|---|---|
| boolean | booleans and strings such as `"true"`, `"false"`, `"1"`, `"0"`, `"yes"`, `"no"` |
| number | numbers and parseable strings |
| string | any primitive converted with `String(...)` |
| array | arrays or JSON array strings |
| object | objects or JSON object strings |

Unknown fields pass through unchanged. Missing required fields are not invented; the tool should report a clear error.

## Platform Notes

Server tools may attach platform-specific notes to the model-visible description. `getToolsForLLM` materializes only the note for the current platform, so other platform notes are not exposed.

## Policy Metadata

`registerServerTool` and `registerWorkstationTool` accept danger/policy metadata such as safe, moderate, or dangerous. The registry stores this metadata for future approval flows.

Dangerous-tool approval may not be fully wired yet, but the metadata is reserved for `requestApproval` style callbacks.

## Self-Registration Flow

Each built-in tool file calls `registerServerTool(...)` or `registerWorkstationTool(...)` at module load time. `tools/index.ts` imports all built-in tool files for side effects.

To add a tool:

1. Create a tool file under the appropriate folder.
2. Register it at top level.
3. Add a side-effect import to `tools/index.ts`.
4. Add focused tests.

## Filtering

`getToolsForLLM(filter)` projects the global registry into the current task's visible tool list. Role and policy filters can allow, deny, or predicate tools without mutating the registry.

The registry stays global; visibility is per call.

## Built-In Server Tools

### `message`

The single user-facing speech channel. It supports:

- `info`: progress or confirmation without ending the task.
- `result`: final answer; writes `finalResult` and usually breaks the task loop.

Blocking `ask` mode and attachments are deferred until the engine and file tools need them.

### `web_fetch`

HTTP GET for one URL with `{ url, mode?: "text" | "html" }`.

- `text` mode strips scripts, styles, and tags, then decodes common entities.
- `html` mode returns raw HTML.
- Enforces size and timeout limits.
- Supports GET only.

The tool is intentionally small and doubles as an end-to-end validation path for the v2 tool pipeline.

## Pitfalls

- Do not register tools from routers or handlers; registration timing becomes unpredictable.
- Do not register the same tool name twice.
- Do not block the Node event loop with heavy synchronous CPU work in server tool handlers.
- Do not call `sessionContext.append` directly from a handler; `tool-execute.ts` writes the tool result.

## Verification

```bash
npm run check
npm test
```

## See Also

- [pipeline.md](./pipeline.md)
- [llm.md](./llm.md)
- [task-loop.md](./task-loop.md)
