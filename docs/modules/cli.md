# CLI

> `server/cli/` —— huko 的命令行 frontend。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/cli/
  index.ts                    入口：argv 解析 + 子命令派发
  bootstrap.ts                公共：装配 Infra + Session persistence + Orchestrator
  state.ts                    `<cwd>/.huko/state.json` 读写（active session）
  commands/
    run.ts                    `huko`
    sessions.ts               `huko sessions <verb>` (list/delete/current/switch/new)
    provider.ts               `huko provider <verb>` (list/add/remove)
    model.ts                  `huko model <verb>`    (list/add/remove/default)
    keys.ts                   `huko keys <verb>`     (set/unset/list)
    config.ts                 `huko config show`
    list.ts                   (legacy stub, kept harmless)
  formatters/
    types.ts                  Formatter 接口
    text.ts                   ANSI 文本（默认）
    jsonl.ts                  每事件一行 JSON
    json.ts                   终态一次性 JSON
    index.ts                  factory + barrel
```

## 命令形态：noun-first

`huko <resource> <verb> [args]`，跟 gh / docker / aws 一个套路。每个
resource 一个 dispatcher 函数（`dispatchSessions` / `dispatchProvider`
等），verb 在内部分发。新增一个 verb 不动顶层路由；新增一个 resource 加
一个 dispatch 函数 + 顶层一个 if 分支。

---

## 命令一览

| 命令 | 干啥 |
|---|---|
| `huko [flags] -- <prompt>` | append 到 active session（没就建一个） |
| `huko sessions list` | 列本地项目 DB 的所有 chat sessions |
| `huko sessions delete <id>` | 级联删除 session + tasks + entries |
| `huko sessions current` | 显示当前 cwd 的 active session |
| `huko sessions switch <id>` | 把 `<id>` 设为当前 cwd 的 active |
| `huko sessions new [--title=...]` | 建新 session 并设为 active |
| `huko provider list` | 列 `~/.huko/infra.db` 里的所有 providers |
| `huko provider add <flags>` | 添加 provider 定义（不含 key 值） |
| `huko provider remove <id|name>` | 删除 provider（cascade 到 models） |
| `huko model list` | 列所有 model + 哪个是 system default |
| `huko model add <flags>` | 添加 model 链接到一个 provider |
| `huko model remove <id>` | 删除 model |
| `huko model default [<id>]` | 显示或设置 system default model |
| `huko keys set <ref> <value>` | 写到 `<cwd>/.huko/keys.json`（chmod 600） |
| `huko keys unset <ref>` | 从 `<cwd>/.huko/keys.json` 移除 |
| `huko keys list` | 显示每个 ref 的解析层（不显示 value） |
| `huko config show` | 打印生效的 huko.config（layered） |

注意 `npm run huko -- ...` 需要 `--` 分隔 npm 参数和命令参数；安装为全局
bin 后可以直接 `huko ...`。

---

## 第一次设置（典型流程）

```bash
# 1. 加 provider 定义（不含 key 值）
huko provider add --name=OpenRouter --protocol=openai \
                  --base-url=https://openrouter.ai/api/v1 \
                  --api-key-ref=openrouter

# 2. 提供 key（任选一种）
huko keys set openrouter sk-or-...                 # 写到 <cwd>/.huko/keys.json
# OR
export OPENROUTER_API_KEY=sk-or-...                # shell rc

# 3. 加 model + 设默认
huko model add --provider=OpenRouter \
               --model-id=anthropic/claude-3.5-haiku --default

# 4. 跑！
huko -- hello
```

---

## 命令细节

### `huko [flags] -- <prompt>`

**Argv 协议**：Flag 放最前面；`--` sentinel **必填**，后面所有内容逐字成为 prompt（包括 `--xxx` 形式的内容）。强制 `--` 是为了让"第一个 bare word"始终明确归属于 subcommand 选择，typo 的子命令（如 `huko sesions list`）不会被静默吞成 prompt 发给 LLM。这意味着：

- `huko --new -- explain --no-interaction works` — 合法，prompt 含 `--no-interaction`
- `huko -- hello` — 合法，prompt = "hello"
- `huko --new` — 合法（空 prompt → runCommand 决定：读 stdin / 报错）
- `huko -- -3 + 5 = ?` — 合法，prompt 可以以 `-` 开头
- `huko --new fix the bug` — **错误**：bare positional 没有 `--` 引导
- `huko sesions list` — **错误**：unknown subcommand（不会被当作 prompt）


#### Session 选择规则

```
1. --session=<id>     → 一次性 send 到 <id>，active 指针不动；id 不存在 → exit 4
2. --new              → 强制新 session，把 active 切到它
3. （默认）           → 接续 active session（若仍在 DB 里）；否则建一个并设 active
4. --memory           → 永远新 ephemeral session，state.json 完全不读不写
```

`--new` 和 `--session=<id>` 互斥（exit 3）。

#### 行为

1. Bootstrap 两个 persistence：infra（`~/.huko/infra.db`）+ session（`<cwd>/.huko/huko.db`）
2. 验证 default model（exit 3 + 提示去 `huko model add ... --default`）
3. 解析 chat session id（按上面规则）
4. `sendUserMessage` → 等 `result.completion`
5. 终态状态 → exit code（done=0 / failed=1 / stopped=2）
6. SIGINT：第一次 → `orchestrator.stop()` 优雅退出；第二次 → exit 130

#### 输出格式

| 模式 | stdout | stderr |
|---|---|---|
| `text`（默认） | assistant 终极回答（流式 token） | tool calls / tool results / reminders / thinking deltas (dim) / final summary |
| `jsonl` | 每个 HukoEvent 一行 JSON | 仅 fatal error |
| `json` | task 完成时一份 JSON 文档（status / final / usage / counts） | 进度提示（tool calls / tool results） |

**核心约定**：stdout 是"结果流"，stderr 是"诊断流"。`huko -- ... > out.txt`
永远只捕获 stdout 的结果——shell pipe 友好。

#### 选项

```
--format=text|jsonl|json   输出格式（默认 text）
--json | --jsonl           等价于 --format=json/jsonl
--title=<text>             仅当**新建** session 时使用
--memory                   Ephemeral 模式（见下）

--new                      强制新 session 并切 active
--session=<id>             一次性发到指定 session（active 不动）
-h, --help                 帮助
```

#### `--memory` ephemeral 模式

```bash
huko --memory "private question"
```

行为：

- session / tasks / entries 全在内存，进程退出全消失
- providers / models / default model 从 `~/.huko/infra.db` 读一次 seed 进
  MemoryInfraPersistence，随后 SQLite 连接关闭——本次 run 不写盘
- `state.json` 完全不读不写——active 指针不变
- 适合 throw-away 提问 / CI 临时调用 / 不污染历史

实现层在 `bootstrap.ts`，**只跟 InfraPersistence + SessionPersistence 抽象打交道**。

---

### `huko sessions <verb>`

#### `sessions list`

```bash
huko sessions list
huko sessions list --json
huko sessions list --jsonl
```

只读 inspector，列出 `<cwd>/.huko/huko.db` 里的所有 chat sessions（**包括**
所有 `huko` 跑过留下的会话）。按 `createdAt` 倒序。

#### `sessions delete <id>`

级联删 session + tasks + entries（cascade 在 SessionPersistence 实现）。
**不交互式确认**——这是 single-user dev CLI。如果删的恰好是 active 指
针，自动清掉指针，下次 `huko` 会建新的。

#### `sessions current`

打印当前 cwd 的 active session id + title。`(none)` 表示没有。如果指针
指的 id 已不在 DB（被外部删了），打印 id + 备注"no longer in DB"。

#### `sessions switch <id>`

校验 `<id>` 存在 → 设为 active。不存在 → exit 4。

#### `sessions new [--title=...]`

创建一条空 session 并设为 active。stdout 打印新 id（方便 shell 捕获）。

---

### `huko provider <verb>`

`provider` 操作的是 `~/.huko/infra.db`——**用户全局**，不依赖 cwd。

#### `provider add`

```bash
huko provider add --name=OpenRouter --protocol=openai \
                  --base-url=https://openrouter.ai/api/v1 \
                  --api-key-ref=openrouter \
                  --header=HTTP-Referer=https://huko.dev \
                  --header=X-Title=Huko
```

| flag | 说明 |
|---|---|
| `--name=<text>` | 显示名（必填） |
| `--protocol=<openai|anthropic>` | 必填 |
| `--base-url=<url>` | http(s) 端点（必填） |
| `--api-key-ref=<name>` | 逻辑 key 名（必填）；运行时 resolve |
| `--header=K=V` | 可重复；写入 `defaultHeaders` |

如果 `--api-key-ref` 当前**还没**对应可解析的 value，stderr 打印 warning
+ 提示三层都可以放在哪——但**不**阻断创建。这样允许"先建 provider 定义、
再 `huko keys set` 提供 key"的两步流程。

#### `provider remove <id|name>`

接受数字 id 或字符串 name。删除 provider 同时 cascade 删它名下所有 models
（FK CASCADE）。

---

### `huko model <verb>`

#### `model add`

```bash
huko model add --provider=OpenRouter \
               --model-id=anthropic/claude-3.5-haiku \
               --display-name="Claude 3.5 Haiku" \
               --default
```

| flag | 说明 |
|---|---|
| `--provider=<name|id>` | 必填；接受 provider name 或 id |
| `--model-id=<vendor-id>` | 必填；vendor 的型号串（如 `anthropic/claude-sonnet-4`） |
| `--display-name=<text>` | 默认 = `--model-id` |
| `--think-level=<lvl>` | off/low/medium/high；默认 off |
| `--tool-call-mode=<mode>` | native/xml；默认 native |
| `--default` | 同时设为系统默认 |

#### `model default [<id>]`

不带参数 → 打印当前 system default。带参数 → 设。

#### `model remove <id>`

删除一条 model。如果它恰好是 system default，自动清掉默认指针（提示用
`huko model default <id>` 重设）。

---

### `huko keys <verb>`

#### `keys set <ref> <value>`

写到 `<cwd>/.huko/keys.json`，POSIX 上 chmod 600。Windows 上忽略 chmod
（`.huko/.gitignore` 默认排除 `keys.json`）。

#### `keys unset <ref>`

从 `<cwd>/.huko/keys.json` 移除。如果文件不存在或没有该 ref → exit 4。

#### `keys list`

打印每个 provider 的 `apiKeyRef` + 它当前命中的层 + 对应 env-var 名 +
哪些 provider 在用它。**永不**打印 value。如果有 `unset` 行，下方会再
列出三层规则。

---

## 与 daemon 的关系

- **infra DB** (`~/.huko/infra.db`) CLI 和 daemon 共用——daemon 配置的
  providers / models / 默认 model 立刻被 CLI 看到，反之亦然
- **session DB** (`<cwd>/.huko/huko.db`) 跟 cwd 走——daemon 在哪个目录起
  的就用哪个。CLI 在不同目录跑就是不同的 session DB
- WAL 模式允许多读单写；daemon 跑着时再开 CLI 短时间没问题，但任意一方
  mutation 期间另一方 mutation 会等锁

`--memory` 模式两边都走内存，跟 daemon 完全不冲突。

---

## 嵌入式使用范例

**shell pipe 取干净结果**：

```bash
result=$(huko --json "Generate a haiku" | jq -r .final)
echo "$result"
```

**git pre-commit hook**：

```bash
#!/bin/sh
diff=$(git diff --cached)
verdict=$(huko --memory --json "Review this diff for obvious bugs. Return YES if OK to commit, NO with reason otherwise.\n\n$diff")
if echo "$verdict" | jq -r .final | grep -q '^NO'; then
  echo "$verdict" | jq -r .final
  exit 1
fi
```

**CI 摘要**：

```bash
huko --memory "Summarize this CI log into 3 bullets, focus on failures" < build.log
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

CLI 主流程只跟接口打交道，不知道具体格式。加新格式 = 新建一个 formatter
文件 + factory 加一行。

---

## 设计选择

### 为什么 active session 是 per-cwd

跟 git/HEAD 思路一致——每个项目目录有自己的对话线。切目录 = 切上下文。
跨项目找老对话用 `huko sessions list`（视野是 cwd 的 session DB）。

### 为什么 `--memory` 不读 state.json

ephemeral 模式按定义就是"这次别留痕"，去摸 `state.json` 反而违反这个承
诺。`--memory` 永远开新 session，跟 `--new` 类似但更彻底（DB 也不写）。

### 为什么 `--session=<id>` 不更新 active

它是"一次性发"，不是"切上下文"。要切就用 `huko sessions switch`。这俩
分开避免脚本里"跑一次就把我 active 偷换了"的事故。

### 为什么不引 commander/yargs

argv 解析手写（`server/cli/index.ts`）目前 ~600 行，多数是 help text。
解析逻辑本身 ~150 行。多一个依赖增加 bundle 体积 + 上游升级风险。等
verbs 真到 30+ 再考虑。

### 为什么 SIGINT 第一次软停、第二次硬退

软停（`orchestrator.stop()`）会 abort LLM call、把 task 状态 update 到
`stopped`、emit `task_terminated{status:stopped}`——即所有清理工作做完。
如果 LLM 已经卡死或 SIGINT 被 ignore，第二次 Ctrl+C 用 `process.exit(130)`
强制退。

---

## 易踩的坑

- **不要**期望 `huko` 在 ephemeral 之外不修改 active session 指针——
  默认行为就是写 `<cwd>/.huko/state.json`
- **不要**手写 `apiKey: process.env["..."]` 在 demo / 测试代码里——用
  `apiKeyRef` 让 `resolveApiKey` 处理，统一行为
- **不要**让 jsonl 模式的 stdout 给人看——它是机器可读流，给人类看用
  `--format=text`
- **不要**让 daemon 和 CLI 同时写同一个 `huko.db`——读没问题（WAL 多读），
  并发写会等锁
- **不要**`huko sessions delete` 当前 active session 后期望 `huko`
  提示——指针自动清掉，悄悄建新的（这是设计选择，避免堆积错误信息）

---

## 验证

```bash
npx tsc --noEmit          # 类型检查
huko --memory "ping"  # 端到端冒烟（前提：env 里有 OPENROUTER_API_KEY 或 keys.json 配好）
```

---

## 见

- [orchestrator.md](./orchestrator.md) — `sendUserMessage` 的契约
- [persistence.md](./persistence.md) — Infra + Session 两个 DB 的语义
- [security.md](./security.md) — keys.json / env / .env 三层查找
- HukoEvent 协议（`shared/events.ts`）— formatter 消费的事件 schema
