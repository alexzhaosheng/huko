# Resume / Orphan Recovery

> `server/task/resume.ts` —— 启动时扫描非终态 task 并修复历史一致性。
>
> 见 [架构总览](../architecture.md) 和 [agent-design-notes.md](../agent-design-notes.md) §6。

---

## 何时跑 + 跑什么

`recoverOrphans(persistence)` 在每次进程**启动时**跑一次。CLI bootstrap 和 daemon
entry 都调它（ephemeral `--memory` 模式跳过——内存里没有历史孤儿）。

它做三件事：

1. `persistence.tasks.listNonTerminal()` 扫所有 status 不是 `done` / `failed` /
   `stopped` 的 task
2. 按 status 分类处理（见下）
3. 把每个修复完的 task 标记 `failed` + 写 `errorMessage`

幂等：第二次跑时 `listNonTerminal()` 返回空，啥也不做。

---

## 三种 checkpoint 形态

### 1. `running` 带 dangling tool_calls（最隐蔽）

LLM 输出了 `assistant(toolCalls=[tc1, tc2])` 但进程在 tool_results 落库前死了。
下次任何对这个 session 的 LLM 调用会被 Anthropic / OpenAI / Gemini **400 掉**——
配对约束（见 [pipeline.md](./pipeline.md) compaction 章节同款）。

修复：

```
对每个 dangling callId:
  persistence.entries.persist({
    kind: ToolResult,
    role: "tool",
    content: "Error: tool execution interrupted by process termination ...",
    toolCallId,
    metadata: { error: "interrupted", synthetic: true },
  })

然后 mark task=failed
```

合成的 tool_result 行**为未来 continue-conversation 服务**——保配对，让
LLM 下一轮看到"哦那个工具中断了"，自己决定 retry 还是 move on。

### 2. `waiting_for_reply`

Task 暂停在 `message --type=ask`，用户没回复进程就死了。huko v1 还没真的实现 ask
flow（message 工具只支持 info / result），所以这条路径**目前是防御性占位**。
未来 ask 落地时，resume 也可以改成"重新 emit 这个 ask event 让用户继续"，
现在先 mark failed 即可。

### 3. `waiting_for_approval`

同 #2 的形状，等 `requestApproval` callback 落地。当前 mark failed。

---

## 不做的事（v1）

- **不重启 task loop**。WeavesAI 的完整 resume 是把 TaskContext 重建出来继续跑。
  huko 的 CLI-first 定位下，"mark failed + 让用户手动 `huko --session=N`
  开新 task"已经够。重启 task 需要重新 resolve model config / tools / executors，
  代价大于价值
- **不周期性扫描**。WeavesAI 启动 + 每分钟跑一次。huko 启动时跑一次就够——CLI
  没有"长时间运行后某 task 被踢"的概念，daemon 落地后再加 heartbeat 也不晚
- **不细分 errorMessage**。所有 healed task 用统一格式：
  `"process exited mid-tool; N synthetic tool_result(s) injected for pairing"`
  之类

---

## 跟 compaction 的连接点

每次 `loadLLMContext(sessionId)` 调用——resume / 未来 continue-conversation 都
会用——会自动**过滤** compaction 标记过的 elided entries。机制：

1. 扫所有 SystemReminder 行
2. 找 `metadata.reminderReason === "compaction_done"`
3. 取 `metadata.elidedEntryIds: number[]`
4. 加载时排除这些 ID

这条逻辑在三个 backend（Memory / Sqlite / File）的 `loadLLMContext` 里各自实现，
共用 helper `collectElidedEntryIds(rows)`（导出自 memory.ts，sqlite/file 都
import 它）。

写入端（compaction 阶段）已经在 [context-manage.ts](./pipeline.md) 把 IDs
塞进 reminder metadata；读取端（resume / continue）在这一刀同步落地。

---

## 调用契约

```typescript
const orchestrator = new TaskOrchestrator({ persistence, emitterFactory });
const report = await orchestrator.recoverOrphans();
// report = { scanned, healed, byKind: { danglingTools, waitingForReply, waitingForApproval, other } }
```

CLI bootstrap：

```typescript
if (!options.ephemeral) {
  const report = await orchestrator.recoverOrphans();
  if (report.healed > 0) {
    process.stderr.write(`huko: recovered ${report.healed} orphan task(s) ...\n`);
  }
}
```

Daemon `core/app.ts`：top-level `await orchestrator.recoverOrphans()` 在
`new TaskOrchestrator(...)` 之后立刻跑。

---

## 易踩的坑

- **不要**在 task 还没 mark failed 之前就开始处理新的 sendUserMessage——pairing
  约束在合成 tool_result 落库后才完整。现在 bootstrap 顺序是先 resume 再返回
  orchestrator 给调用方，自然安全
- **不要**在 ephemeral / `--memory` 模式跑 resume——MemoryPersistence 启动总是
  空的，扫描没意义。bootstrap 已经判断 `if (!options.ephemeral)`
- **不要**给合成 tool_result 写真实 toolName。当前用 `(unknown)`——因为我们没法
  从 assistant 行的 metadata 100% 反推出 callId 对应的 toolName。LLM 看到合成
  错误信息就够了
- **不要**把孤儿 task 的 status 改回 "running" 来重跑——我们没有 TaskContext
  重建路径。修复后只能 mark failed，让用户决定是否新开 task

---

## 见

- [agent-design-notes.md](../agent-design-notes.md) §6 —— WeavesAI 的完整 resume
  设计（含 periodic health check / TaskContext 重建）作为对比参考
- [pipeline.md](./pipeline.md) —— compaction 写入端的 elidedEntryIds 来源
- [task-loop.md](./task-loop.md) —— TaskLoop 不知道 resume 这回事；走的是干净正向流程
