# TaskLoop

> `server/task/task-loop.ts` + `server/task/resume.ts` —— 主状态机。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/task/
  task-loop.ts         TaskLoop 类 + interject/stop + iteration 循环
  resume.ts            ⏳ stub —— orphan 恢复
```

---

## 一次迭代

```
1. guards: isAborted? iter / tool 预算超了?
2. 队列优先：deferredCalls.shift() → executeAndPersist → continue
3. consumeInterjectionFlag()
4. callLLM() → ok | aborted{stopped|interjected}
       stopped → break
       interjected → continue（新用户消息已在 context，下一轮重新调 LLM）
5. result.toolCalls 非空？
       [first, ...rest] → executeAndPersist(first) + deferredCalls.push(...rest)
       continue
6. 否则：content 非空 → 设 finalResult, break (DONE)
       否则：注入纠正 SystemReminder，bounded 重试，超限 break (FAILED)
7. manageContext(ctx)（目前 stub，见 [pipeline.md](./pipeline.md)）
```

---

## interject vs stop 的语义边界

| 操作 | 触发 abort | 结果 | 调用方责任 |
|---|---|---|---|
| `interject()` | 仅 `currentLlmAbort` | 当前 LLM call 被打断；下轮带新 context 重新调 LLM；任务**不**终止 | **先** `sessionContext.append(用户新消息)`，**再**调 `interject()` |
| `stop()` | `masterAbort` | 当前 LLM 和当前 tool 都被 race 出来；循环退出，status="stopped" | 无 |

**关键**：`interject()` 只**翻 flag + abort 当前 LLM**。它不持久化用户消息——那是 gateway / 调用方的责任。

---

## 单步执行的代价与好处

- **代价**：N 个 tool call 要 N 轮迭代（中间不调 LLM，所以不慢，但每 tool 都过一次 loop）
- **好处**：每个 tool 之间都重新检查 `isAborted` / `interjected` / 预算；worker 队列里能精确插入 reschedule。比批量并行更"反应灵敏"。

队列在 [`TaskContext.deferredCalls`](./engine.md#deferredcalls-队列)。

---

## 容量限制

| 常量 | 默认值 | 触发结果 |
|---|---|---|
| `MAX_ITERATIONS` | 200 | 任务标记 failed |
| `MAX_TOOL_CALLS` | 200 | 任务标记 failed |
| `MAX_EMPTY_RETRIES` | 3 | LLM 连续空回 3 次后 failed |

数值是防御性兜底。生产看到频繁触发说明上游有问题（prompt 设计、模型选择、tool 描述），不是把数字调大就解决。

---

## TaskRunSummary

`run()` 返回的总结：

- `status: "done" | "failed" | "stopped"`
- `finalResult: string` —— 最后一次 LLM 文本回复（或空）
- `hasExplicitResult: boolean`
- `iterationCount` / `toolCallCount` / 三个 token 计数 / `elapsedMs`

---

## resume.ts（⏳ stub）

未来：

- 检测进程退出时 `tasks.status` 仍非终态的任务
- 从 `task_context` history 重建 SessionContext / TaskContext
- 修复三种孤儿状态：
  - `waiting_for_reply` —— 重新弹给用户，不再问 LLM
  - `waiting_for_approval` —— 同上
  - `running` 中断的 tool —— 注入合成 tool_result 表示中断，让 LLM 决策重试或 move on
- 把恢复后的 TaskContext 交给新 `TaskLoop.run()`

**契约保证 `TaskLoop.run()` 永远不知道 resume 这回事**——只走干净正向流程。

---

## 易踩的坑

- **不要**在 `interject()` 里持久化用户消息——这是调用方的责任。
- **不要**期望 `interject()` 立即让 LLM 看到新消息——只 abort 当前 call，下一轮才会带新 context。
- **不要**在 tool handler 里抛 abort——返回 `{result: "", error: "..."}`，让 LLM 自己看到错误纠正。真正的 abort 由 pipeline 的 `raceAbort` 统一处理。
- **不要**绕过 `deferredCalls` 队列直接批量并行 tool——会破坏 single-step enforcement。

---

## 验证

```bash
OPENROUTER_API_KEY=sk-or-... npx tsx scripts/engine-demo.ts
```

端到端跑一次"加法 task"——会看到 LLM 调 add tool、收到结果、最终回复。

---

## 见

- [engine.md](./engine.md) —— TaskContext / SessionContext 的契约
- [pipeline.md](./pipeline.md) —— TaskLoop 委托给 pipeline 的具体步骤
- [tools.md](./tools.md) —— `result.toolCalls` 怎么路由
