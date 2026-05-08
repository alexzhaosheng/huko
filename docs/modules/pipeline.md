# Pipeline

> `server/task/pipeline/` —— TaskLoop 的三件套委托。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/task/pipeline/
  llm-call.ts         一次 LLM 调用：streaming flush + abort + token 计数
  tool-execute.ts     工具执行 + Promise.race(masterAbort) + 持久化
  context-manage.ts   ⏳ stub —— compaction / digests
```

每个文件单一职责，TaskLoop 只编排，不动逻辑。文件超过 ~300 行就该再拆。

---

## llm-call.ts

### 契约

```typescript
function callLLM(ctx: TaskContext): Promise<LLMCallOutcome>

type LLMCallOutcome =
  | { kind: "ok"; entryId: number; result: LLMTurnResult }
  | { kind: "aborted"; reason: "stopped" | "interjected" };
```

### 关键步骤

1. `messages = [{role: "system", content: ctx.systemPrompt}, ...sessionContext.getMessages()]` —— system prompt 在调用时拼，**不**进 session context
2. `appendDraft({content: ""})` 拿 entryId，UI 立刻看到打字机起头
3. 双层 abort 接线：`llmAbort = new AbortController()`，挂到 `ctx.currentLlmAbort`，并把 `ctx.masterAbort.signal` 的 abort 事件转发进来
4. 流式 partial 回调：content/thinking 累加到 buffer，**节流** flush（默认 33 ms）调 `update()`
5. 收到完整 result 后，最终 `update()` 写权威 DB 状态（content + metadata.{thinking, toolCalls, usage}）
6. `commitToContext()` 把消息塞进内存 LLM context
7. `addTokens()` + `iterationCount++`

### Aborted 的判定

catch 到 `AbortError` 时看 `ctx.masterAbort.signal.aborted`：

- true → `stopped`
- false → `interjected`

---

## tool-execute.ts

### 契约

```typescript
function executeAndPersist(ctx: TaskContext, call: ToolCall): Promise<ToolExecOutcome>

type ToolExecOutcome =
  | { kind: "ok"; entryId: number; result: string; shouldBreak?: boolean }
  | { kind: "error"; entryId: number; error: string }
  | { kind: "aborted" };
```

### 行为约定

- **未注册的 tool**：直接 persist 一个 `ToolResult{error: "Tool ... not registered"}`，让 LLM 下一轮自己纠错。**不**抛异常，**不**让任务崩。
- **参数 coerce**：分发前调用 `coerceArgs(name, args)` —— LLM 把 boolean 写成 `"true"` 之类的常见小错就被吃掉。tool handler 看到的是矫正过的 args。
- **Server tool**：`Promise.resolve(handler(args, ctx))`。Handler 可以返回 `string` / `ServerToolResult` / `ToolHandlerResult`。`tool-execute` 内部 normalise 成统一形状。
- **Workstation tool**：`ctx.executeTool(name, args)` 走 Socket.IO 到本地机器（callback 在 TaskContext 上）。无 callback → 持久化 error。
- 全程 `raceAbort(masterAbort, fn)` —— abort 触发时立即 reject，工具可能在后台跑完但我们不等。

### ToolHandlerResult 的语义提升

`ToolHandlerResult` 的字段会被 `tool-execute` 翻译成对 task 的副作用：

| 字段          | 副作用                                                                |
|---------------|-----------------------------------------------------------------------|
| `content`     | 持久化为 `tool_result.content` —— LLM 看到的就是它                    |
| `metadata`    | 合并进 `tool_result.metadata`                                          |
| `summary`     | 写到 `metadata.summary`，UI 紧凑视图用                                |
| `attachments` | 写到 `metadata.attachments`                                            |
| `error`       | 非 null → outcome.kind = "error"，content 改写成 `Error: ...`         |
| `finalResult` | 写入 `ctx.finalResult` + `ctx.hasExplicitResult = true`                |
| `shouldBreak` | outcome 带 `shouldBreak: true`，TaskLoop 看到后干净结束（status=done）|

### 持久化的 ToolResult

- `role: "tool"`
- `toolCallId: call.id`（让 native 协议能配对）
- `metadata: { toolName, arguments, error?, summary?, attachments?, ...extras }`

---

## context-manage.ts（⏳ stub）

当前 no-op。未来在每轮迭代末尾被调用，承担：

- **Compaction**：context 超过阈值时摘要旧 turn，`purgeMessages` 评出，注入合成 summary entry
- **文件浏览摘要**：把长串 file 读取折叠成结构化摘要 entry
- **System reminder 注入**：例如长时静默时提示 LLM 完成任务

注意：deferred 队列是 TaskLoop 在迭代**头部**做的，不归这里管。这模块只做对已持久化历史的形变。

---

## 易踩的坑

- **不要**让 adapter 知道 retry —— retry 是 pipeline 层的责任，不是 LLM 层的。当前**没**实现 retry，需要时加在 `llm-call.ts` 里。
- **不要**把流式 partial 直接调 `update()` 而不节流——会让 WebSocket 被 flood。当前 33 ms throttle 是经验值。
- **不要**在 tool 错误时抛异常——会让上层 raceAbort 误判为 abort。返回 `{result: "", error}`。
- **不要**在 `commitToContext` 之前的 `update()` 里塞最终 metadata——只在最终 update 设一次。

---

## 见

- [llm.md](./llm.md) —— `invoke()` 的下层
- [task-loop.md](./task-loop.md) —— pipeline 的调用方
- [tools.md](./tools.md) —— `getTool()` 的实现
- [engine.md](./engine.md) —— SessionContext 的写入入口
