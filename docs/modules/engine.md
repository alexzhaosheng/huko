# Engine 模块

> `server/engine/` —— task 执行核心的两块基石。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/engine/
  SessionContext.ts        session 级数据总线
  TaskContext.ts           task 级状态容器
shared/
  types.ts                 EntryKind / isLLMVisible / TaskStatus / WS payloads（前后端共用）
```

---

## SessionContext

### 写入入口（共四个，对应不同时态）

| 方法 | DB | WS | LLM context | 用途 |
|---|---|---|---|---|
| `append(payload)` | ✅ | ✅ | ✅（如果 isLLMVisible） | 终态条目（user message / tool result / status notice） |
| `appendDraft(payload)` | ✅ | ✅ | ❌ | 流式 assistant 起手——拿到 entryId 给后续 `update()` 打补丁 |
| `commitToContext(payload)` | ❌ | ❌ | ✅ | 流式终末——把消息 push 进 LLM 内存 context |
| `update(payload)` | ✅ | ✅ | ❌ | 中段流式补丁 / metadata 打标 |

### 核心契约

- 任何绕开这四个方法直接写 DB / 推 WS / 动 `llmContext` 的代码都是 bug。
- `append()` 内部委托私有 `persistAndEmit()`，这是 DB+WS 的真正实现。`appendDraft()` 也走它，但跳过 LLM context push。`commitToContext()` 只动 LLM context。三者职责互斥、组合完整。
- **流式三段式**：`appendDraft` → 多次 `update` → `commitToContext`。LLM context 只在最后一刻收到完整消息，避免 `content: ""` 污染下一轮 prompt。
- `isLLMVisible(kind)` 是**唯一**决策点。`StatusNotice` 不进 LLM；其他都进。
- **依赖注入**：构造时接收 `PersistFn` / `UpdateFn` / `Emitter`。engine 不直接 import db、Drizzle、socket.io。
- `metadata.attachments[].imageDataUrl` 在 persist 前 `stripVolatileFields()` 剥离（DB 不存大 base64）；WS payload 保留以供 UI 首屏渲染。
- **Tool calls 落地形态**：assistant turn 的 `toolCalls?: ToolCall[]` 字段，在 append/appendDraft/commitToContext 的 payload 里都存在。内部走两路：合进 `metadata.toolCalls` 入 DB，作为结构化字段进 `LLMMessage.toolCalls`。

### 内存 LLM context 的写操作

仅有的合法操作：

- `purgeMessages(entryIds)` — 给 compaction 用，按 entryId 删
- `replaceContext(messages)` — 给摘要重写用
- `removeFromTail(predicate)` — 给 retry 剥纠正消息用
- `commitToContext(...)` — 流式终末追加

**任何其他对 `llmContext` 的写都是 bug。**

---

## TaskContext

只装数据，不装业务逻辑。所有 mutation 由 TaskLoop / pipeline 显式做。

### 字段分组

- **标识符**：`taskId / sessionType / chatSessionId / agentSessionId`
- **模型 / LLM call**：`protocol / modelId / baseUrl / apiKey / toolCallMode / thinkLevel / headers / extras`
- **工具**：`tools`（可变，pipeline 按 filterKey 重建）
- **System prompt**：可变（skill 激活会追加）
- **回调**：`executeTool? / requestApproval? / waitForReply?`
- **Abort**：`masterAbort`（永远存在）/ `currentLlmAbort`（pipeline 设置）
- **累加器**：`toolCallCount / promptTokens / completionTokens / totalTokens / iterationCount`
- **结果 flags**：`finalResult / hasExplicitResult / taskFailed / taskStopped`
- **运行时 flag**：`interjected`
- **队列**：`deferredCalls`（单步执行）

### Abort 双层模型

- `masterAbort: AbortController`（永远存在）—— `stop()` 触发。pipeline 用 `masterAbort.signal` 做 `Promise.race`。
- `currentLlmAbort: AbortController | null` —— pipeline 在 LLM 调用前赋值、调用后清空。`interject()` 只 abort 这个，**不动** master。
- 构造时可选的 `externalAbortSignal` 转发进 master——已 aborted 的立即触发；未 aborted 的 `addEventListener("abort", once: true)`。

### deferredCalls 队列

LLM 一轮多 tool call 时：

1. TaskLoop 执行第一个，`push(...rest)` 排队
2. 下一轮**不调 LLM**，从队首 shift 一个执行
3. 直到队列清空，才再次调 LLM

实现 single-step enforcement：每个 tool 之间都重新检查 `isAborted` / `interjected` / 预算。

详见 [task-loop.md](./task-loop.md)。

### 仅有的方法

- `addTokens(usage)` — token 累加
- `summary()` — 结束时给 task:done 用
- `resolveStatus()` — 从 flag 解出 TaskStatus
- `consumeInterjectionFlag()` — 读取并重置 interjected

全部纯计算，不触发副作用。

---

## EntryKind / isLLMVisible (shared/types.ts)

```typescript
export const EntryKind = {
  UserMessage:    "user_message",
  AiMessage:      "ai_message",
  ToolCall:       "tool_call",
  ToolResult:     "tool_result",
  SystemPrompt:   "system_prompt",
  SystemReminder: "system_reminder",
  StatusNotice:   "status_notice",   // 唯一不进 LLM 的
} as const;

export function isLLMVisible(kind: EntryKind): boolean {
  return kind !== EntryKind.StatusNotice;
}
```

**规则**：除 `StatusNotice` 外所有 EntryKind 都进 LLM context。这是单一决策点。**调用方不传 dispatch flag**。

---

## 易踩的坑

- **不要**用 `append()` 来开流式 assistant 消息——用 `appendDraft()`，否则 LLM context 会塞进 `content: ""`。
- **不要**在 `commitToContext()` 之前的多次 `update()` 里重复传 `toolCalls` metadata——会被反复合并；只在最终 update 传一次。
- **不要**让 TaskContext 持有 LLM context 数组——破坏 session 跨 task 共享语义。
- **不要**在 `stop()` 之外触发 `masterAbort.abort()`——破坏所有权语义。需要 abort 走 `stop()`。
- **不要**把 system prompt 当 session entry append 进去——它是 task 级配置，由 pipeline 拼接。

---

## 见

- [task-loop.md](./task-loop.md) — TaskContext 怎么被驱动
- [pipeline.md](./pipeline.md) — SessionContext 写入的实际调用方
- [llm.md](./llm.md) — `LLMMessage.toolCalls` 字段在协议层的用法
