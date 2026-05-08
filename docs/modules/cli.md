# CLI

> `server/cli/` —— huko 的命令行 frontend。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/cli/
  index.ts                    入口：argv 解析 + 子命令派发
  bootstrap.ts                公共：装配 SqlitePersistence + Orchestrator
  commands/
    run.ts                    `huko run` 实现
  formatters/
    types.ts                  Formatter 接口
    text.ts                   ANSI 文本（默认）
    jsonl.ts                  每事件一行 JSON
    json.ts                   终态一次性 JSON
    index.ts                  factory + barrel
```

---

## 当前实现：`huko run`

```bash
npm run huko -- run "What is 2 + 2?"
npm run huko -- run --jsonl "Summarize this" 
npm run huko -- run --json "do X"
```

注意 `npm run` 需要 `--` 分隔脚本参数和命令参数。如果将来加 `bin` 字段并 npm install 全局，就可以直接 `huko run "..."` 不用 `--`。

### 行为

1. 跑 SqlitePersistence 的 migrations（幂等，与 daemon 共享 huko.db）
2. 验证有 `app_config.default_model_id`，没有就 exit 3 并提示去种子
3. 创建 ephemeral chat session（标题 `cli YYYY-MM-DD HH:MM`）
4. `sendUserMessage` → 等 `result.completion` 解析
5. 根据终态状态退出：
   - `done` → 0
   - `failed` → 1
   - `stopped` → 2
   - 异常抛出 → 1
   - usage error / 缺默认 model → 3
6. SIGINT 处理：第一次 Ctrl+C 调 `orchestrator.stop()` 走优雅终止；第二次硬退 exit 130

### 输出格式

| 模式 | stdout | stderr |
|---|---|---|
| `text`（默认） | assistant 终极回答（流式 token） | tool calls / tool results / reminders / thinking deltas (dim) / final summary |
| `jsonl` | 每个 HukoEvent 一行 JSON | 仅 fatal error |
| `json` | task 完成时一份 JSON 文档（status / final / usage / counts） | 进度提示（tool calls / tool results） |

**核心约定**：stdout 是"结果流"，stderr 是"诊断流"。`huko run "..." > out.txt` 永远只捕获 stdout 的结果——shell pipe 友好。

### 选项

```
--format=text|jsonl|json   输出格式（默认 text）
--json                     等价于 --format=json
--jsonl                    等价于 --format=jsonl
-h, --help                 帮助
```

---

## 与 daemon 的关系

CLI 和 daemon **共用同一个** SqlitePersistence（同一个 huko.db）：

- 在 daemon 配置好的 providers / models / 默认模型 → CLI 直接复用
- CLI 创建的 session → daemon 的 web 端（如有）也能看到
- **不可同时两个进程跑**——SQLite WAL 模式允许多读单写，daemon 跑着时再开 CLI 短时间没问题，但任意一方 mutation 期间另一方 mutation 会冲突

未来 `--memory` 模式会用 MemoryPersistence，完全不碰 huko.db，可与 daemon 并行。

---

## 嵌入式使用范例

**shell pipe 取干净结果**：

```bash
result=$(npm run huko --silent -- run --json "Generate a haiku" | jq -r .final)
echo "$result"
```

**git pre-commit hook**：

```bash
#!/bin/sh
diff=$(git diff --cached)
verdict=$(npm run huko --silent -- run --json "Review this diff for obvious bugs. Return YES if OK to commit, NO with reason otherwise.\n\n$diff")
if echo "$verdict" | jq -r .final | grep -q '^NO'; then
  echo "$verdict" | jq -r .final
  exit 1
fi
```

**CI 摘要**：

```bash
npm run huko -- run "Summarize this CI log into 3 bullets, focus on failures" < build.log
```

**JSONL → 实时事件流处理**：

```bash
npm run huko -- run --jsonl "..." \
  | jq --unbuffered 'select(.type == "tool_result") | "\(.toolName): \(.content[:60])"'
```

---

## Formatter 抽象

每种格式实现 `Formatter` 接口：

```typescript
interface Formatter {
  emitter: Emitter;                          // 接收 HukoEvent
  onTaskStarted?(taskId: number): void;      // 可选：任务起点 hook
  onSummary(summary: TaskRunSummary): void;  // 终态正常
  onError(err: unknown): void;               // 异常路径
}
```

CLI 主流程只跟接口打交道，不知道具体格式。加新格式 = 新建一个 formatter 文件 + factory 加一行。

---

## 设计选择

### 为什么单进程内一个 formatter

CLI 的一次性模式只跑一个 task。`emitterFactory(_room)` 永远返回**同一个** emitter（即 formatter 的 emitter），不区分 session room——单 task 没必要做路由。daemon 模式才需要 per-room 隔离。

### 为什么 SqlitePersistence 不是 MemoryPersistence

为了与 daemon 共享 providers / models / 默认配置。MemoryPersistence 的话每次 CLI 运行都得重新种子。当前轻量配置阶段 sqlite 共享更友好。`--memory` 模式下一刀加。

### 为什么不引 commander/yargs

argv 解析 30 行手写够了。多一个依赖增加 bundle 体积、增加一个上游升级风险。等子命令多到 5+ 再考虑。

### 为什么 SIGINT 第一次软停、第二次硬退

软停（`orchestrator.stop()`）会 abort LLM call、把 task 状态 update 到 `stopped`、emit `task_terminated{status:stopped}`——即所有清理工作做完。但如果 LLM 已经卡死或 SIGINT 被 ignore，第二次 Ctrl+C 用 `process.exit(130)` 强制退出。

---

## 易踩的坑

- **不要**把 prompt 写到 stdout 给后续命令——`echo "prompt" | huko run` 这种 stdin 输入 v1 还没支持。要传 prompt 走 argv（`huko run "the prompt"`）
- **不要**期望 daemon 模式下也用 `huko run`——它是本地 ephemeral，会启自己的 orchestrator。要走 daemon 等 `huko send` 落地
- **不要**在 jsonl 模式下写 stdout 当人类可读输出——它是机器可读流，要给人类看用 `--format=text`
- **不要**让 SqlitePersistence 在 CLI 跑期间被另一个写者并发——读没问题（WAL 多读），并发写会等锁

---

## 验证

```bash
# 前提：default_model_id 已配（用 orchestrator-demo.ts 种子或 daemon 配置）

# 默认 text 模式
npm run huko -- run "Tell me a haiku about cats"

# JSONL 流模式
npm run huko -- run --jsonl "What is 2 + 2?" | head

# JSON 单结果
npm run huko -- run --json "What is 2 + 2?"
```

---

## 见

- [orchestrator.md](./orchestrator.md) — `sendUserMessage` 的契约
- [persistence.md](./persistence.md) — SqlitePersistence 与 daemon 的共享语义
- HukoEvent 协议（`shared/events.ts`）— formatter 消费的事件 schema
