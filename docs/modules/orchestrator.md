# TaskOrchestrator

> `server/services/task-orchestrator.ts` —— HTTP/WS 与 engine 之间的总枢。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/services/
  task-orchestrator.ts        主类
  index.ts                    barrel
scripts/
  orchestrator-demo.ts        端到端烟测（迁移 + 种子 + 真 DB + 流式）
```

---

## 职责

orchestrator 是**装配点 + 路由器 + 生命周期管家**：

- 缓存活跃 SessionContext（按 `${type}:${id}`），sessions 长寿、跨多个 task
- 跟踪运行中的 TaskLoops（按 taskId），给 `stop / interject` 路由
- 在 task 启动时把 DB adapter + emitter 注入 SessionContext
- 通过 `models ⨝ providers` 查询解析模型配置
- task 跑完更新 DB 行 + 推 lifecycle 事件 + 清理引用

**不**做：
- 直接说 HTTP / Socket.IO（用 `EmitterFactory` 解耦）
- Auth / users（huko 单用户）
- 业务逻辑（那是 TaskLoop / pipeline 的事）

---

## 公开 API

```typescript
class TaskOrchestrator {
  constructor(opts: {
    db: Db;
    emitterFactory: (room: string) => Emitter;   // 例如 (room) => io.to(room) 包装
    defaultSystemPrompt?: string;
  });

  // Session 管理
  createChatSession(title?: string): Promise<number>;

  // 主入口（tRPC chat.sendMessage 调这个）
  sendUserMessage(input: {
    chatSessionId: number;
    content: string;
    attachments?: UserAttachment[];
    modelId?: number;
  }): Promise<{
    taskId: number;
    interjected: boolean;
    completion: Promise<TaskRunSummary>;
  }>;

  // 控制（tRPC task.stop 调这个）
  stop(taskId: number): boolean;

  // 等任务终态（demo / 测试用）
  awaitTask(taskId: number): Promise<TaskRunSummary>;
}
```

---

## sendUserMessage 内部分两路

```
sendUserMessage(input)
  sessionContext = getOrCreateSessionContext(...)
  if (sessionToLoop has chatSessionId) {
    // 已有活跃 task：interject 路径
    await sessionContext.append({user message, taskId: liveTaskId})
    liveLoop.interject()
    return { taskId: liveTaskId, interjected: true, completion: existingPromise }
  }
  // 新 task 路径
  return startNewTask(...)
```

**关键顺序**（interject 路径）：先 `append` 新用户消息（让 LLM context 已经更新），再 `interject()`（abort 当前 LLM call）。loop 下一轮的 LLM 调用会带上新消息。

---

## startNewTask 流程

```
1. resolveModelConfig(input.modelId ?? app_config.default_model_id)
2. INSERT tasks (status='running', modelId, toolCallMode, thinkLevel)
   → 拿到 taskId
3. await sessionContext.append({UserMessage, taskId, content, attachments?})
4. new TaskContext(...) 把 modelConfig + tools + systemPrompt 装进去
5. new TaskLoop(taskContext)
6. liveLoops.set(taskId, loop), sessionToLoop.set(sessionKey, taskId)
7. completion = loop.run().then(handleTaskDone, handleTaskCrash)
8. return { taskId, interjected: false, completion }
```

第二步把 `tasks.status` 直接置为 `running`（不走 pending 中间态）——状态机够用。

---

## Task 生命周期收尾

`loop.run()` 的 promise 接 `.then/.catch`：

**handleTaskDone(summary):**
- `UPDATE tasks SET status, finalResult, *Tokens, *Count, updatedAt`
- 通过缓存的 emitter 推 `task:${summary.status}` 事件（`task:done` / `task:stopped` / `task:failed`）
- 清理 `liveLoops` / `sessionToLoop`
- **保留** `liveSessions` 与 `taskCompletions`——session 还活着，且 awaitTask 可能晚到

**handleTaskCrash(err):**
- `UPDATE tasks SET status='failed', errorMessage`
- 推 `task:error` 事件
- 同样清理 + 保留

---

## 三个核心 Map（+ 一个完成 Promise 表）

| Map | 键 | 值 | 何时清 |
|---|---|---|---|
| `liveSessions` | `chat:42` | SessionContext | 永不清（单用户低量；session 长寿） |
| `liveSessionEmitters` | `chat:42` | Emitter | 同上 |
| `liveLoops` | taskId | TaskLoop | task 终态时 |
| `sessionToLoop` | `chat:42` | taskId | task 终态时 |
| `taskCompletions` | taskId | `Promise<TaskRunSummary>` | 进程重启 |

`taskCompletions` 不主动清是因为 `awaitTask()` 可能晚到——如果清了，要从 DB 行 `summaryFromRow()` 重建（已实现 fallback）。

---

## EmitterFactory：解耦 Socket.IO

orchestrator 只看到：

```typescript
type Emitter = { emit: (event: string, data: unknown) => void };
type EmitterFactory = (room: string) => Emitter;
```

未来的 gateway 这样把 Socket.IO 接进来：

```typescript
const orchestrator = new TaskOrchestrator({
  db,
  emitterFactory: (room) => ({
    emit: (e, d) => io.to(room).emit(e, d),
  }),
});
```

orchestrator 永远不知道 Socket.IO 的存在——同 engine "零基础设施依赖" 的原则。

---

## 模型配置解析

```sql
-- resolveModelConfig 的等价 SQL
SELECT
  m.model_id,
  m.default_think_level,
  m.default_tool_call_mode,
  p.protocol,
  p.base_url,
  p.api_key,
  p.default_headers
FROM models m
JOIN providers p ON p.id = m.provider_id
WHERE m.id = ?  -- 来自参数或 app_config.default_model_id
```

如果调用方没传 `modelId`，从 `app_config.default_model_id` 读。两者都没 → 抛错。`app_config.value` 是 JSON，`mode: "json"`，存的是数字会以 `number` 形态读出。

---

## 易踩的坑

- **不要**在 `sendUserMessage` 里跳过 SessionContext 直接写 DB——绕过 SessionContext 一调三发，UI 看不到事件，LLM context 也不会更新。
- **不要**在 interject 路径里忘记 `await` 用户消息的 append——必须先持久化再 abort，否则 loop 重启的下一轮看不到新消息。
- **不要**在 `startNewTask` 里把 `task_context.task_id` 留空——FK NOT NULL，先 INSERT task 行拿 taskId 才能 append。
- **不要**手动操作 `liveLoops` / `sessionToLoop`——只有 `cleanupTask` 该清，其他写入只发生在 `startNewTask`。
- **不要**让 `EmitterFactory` 依赖外部状态——它会被 orchestrator 多次调用（每个新 session 一次），实现要 stateless 或自带 socket 句柄。

---

## 验证

```bash
OPENROUTER_API_KEY=sk-or-... npx tsx scripts/orchestrator-demo.ts
```

会：迁移 → 种子 OpenRouter provider + model + 默认 → 建 chat session → 发用户消息 → 流式打字机 → 收到 `task:done` → 打印 summary → 优雅关闭 SQLite。

---

## 见

- [db.md](./db.md) — `makePersistEntry` / `makeUpdateEntry` / `loadSessionLLMContext` 的来源
- [engine.md](./engine.md) — SessionContext 与 TaskContext 的契约
- [task-loop.md](./task-loop.md) — `loop.run()` / `interject()` / `stop()` 的语义
- [pipeline.md](./pipeline.md) — task 内部一轮迭代的步骤
