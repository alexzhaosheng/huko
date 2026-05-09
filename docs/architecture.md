# huko 架构总览

> huko 是一个**轻量、可嵌入、可定制的 agent 内核**——不是 chat 应用，不是 web 产品。
>
> 它是给 shell 脚本、CI、Make、git hook、IDE 插件、自动化工作流当 building block 用的。
>
> 新会话先读这一份，再按需打开模块文档。
>
> **本文应保持精简**——只装跨模块原则与索引。模块特定的设计放在 `modules/<name>.md`。

---

## 一、定位

huko 的形态是 **kernel + 可插拔扩展**：

```
┌────────────────────────────────────────┐
│         Frontends（消费方）           │
│ ─────────────────────────────────────  │
│   CLI 一次性    `huko run "..."`       │
│   CLI 后台      `huko start` + `send`  │
│   CLI 交互      `huko chat`            │
│   外部 web UI   独立包，订阅事件流     │
│   IDE 插件      同上                   │
└────────────────────────────────────────┘
              ↑ 语义事件 (HukoEvent)
              ↓ 控制接口 (tRPC / 直接 API)
┌────────────────────────────────────────┐
│             huko kernel                │
│ ─────────────────────────────────────  │
│   TaskOrchestrator                     │
│   TaskLoop / pipeline                  │
│   SessionContext / TaskContext         │
│   LLM 协议适配                         │
│   Tool registry                        │
└────────────────────────────────────────┘
              ↑ 接口注入
              ↓ 实现
┌────────────────────────────────────────┐
│        Pluggable extensions            │
│ ─────────────────────────────────────  │
│   Persistence: null / file / sqlite    │
│                + 外部 (postgres / ...) │
│   Tools: builtin / npm 插件 / ad-hoc   │
│   Skills: 同上（未来）                 │
│   Frontends: 见上                      │
└────────────────────────────────────────┘
```

**核心设计承诺**：

- 内核**不假设 UI**——所有输出是语义事件流（HukoEvent），渲染由消费方决定
- 内核**不假设持久化**——通过 `Persistence` 接口注入，内置 null/file/sqlite，其余外挂
- 内核**不绑定单一 frontend**——HTTP daemon、CLI 一次性、CLI 后台都是 kernel 的消费者
- Tools / Skills 可在**运行时**临时注入，不必修改主仓库

---

## 二、基本原则

跨模块的契约。新模块设计前先扫一遍。

### 边界与依赖

- **Kernel 零基础设施假设**：`server/engine/` / `server/task/` / `server/services/` 永远不直接 import HTTP 库 / Socket.IO / 具体 DB / UI 框架。基础设施通过构造函数注入。
- **Frontend 不被 kernel 反向 import**：内核暴露事件 + 接口；frontend（CLI、daemon HTTP、外部 web）调用内核。**反过来不行**。
- **持久化通过 `InfraPersistence` + `SessionPersistence` 接口**——按 scope 分两份：
  - `InfraPersistence` 在 `~/.huko/infra.db`：providers / models / 系统默认（用户全局）
  - `SessionPersistence` 在 `<cwd>/.huko/huko.db`：sessions / tasks / entries（项目级）
  - 内核**不**直接 import drizzle / better-sqlite3
- **API key 永不进 DB**——`providers.api_key_ref` 是逻辑名，运行时由
  `server/security/keys.ts` 三层查找（`<cwd>/.huko/keys.json` > env > `<cwd>/.env`）解析为真值

### Context 写入垄断

- **SessionContext 是 context 唯一写入入口**。绕开它直接动持久化或直接推事件的代码都是 bug。
- **`isLLMVisible(kind)` 是哪些 entry 进 LLM context 的单一决策点**。调用方不传 dispatch flag。
- **System prompt 不进 session**——它是 task 级配置，由 pipeline 在 LLM 调用时即时拼接。

### 输出协议

- **`HukoEvent` 是 kernel → frontend 的单一协议**。所有"发生了什么"都通过它传递，不掺杂文本格式或渲染指令。
- 事件**带语义类型**而非松散字符串：`assistant_text_delta` / `tool_call` / `ask_user` / `task_terminated` …
- Frontend（CLI 文本格式化器、CLI JSON 输出、外部 web、IDE 插件）都是 HukoEvent 的不同消费者。
- **永不**把 HTML / ANSI / JSON 字符串塞进事件 payload——payload 是结构化数据。

### 注册与扩展

- **副作用注册模式**：协议 adapter、内置工具，集中显式注册（`register.ts` / `tools/index.ts`）。**不**用模块顶层自注册。
- **依赖 registry 的公开函数必须自己 side-effect import 注册器**——例：`invoke()` 顶部 `import "./register.js"`；`TaskOrchestrator` 顶部 `import "../task/tools/index.js"`。
- **新增功能前先问自己**：分发点（registry）还是工厂帮手？分发点要进 registry，工厂帮手只是命名好的便利封装。
- **可插拔的边界**：Persistence、Tool、Skill、Frontend 这四个概念是"插槽"，每个都有：
  1. 一个**接口/契约**定义在内核里
  2. 内置**最小默认实现**（null/file/sqlite，message/echo 等）
  3. 外部实现通过 npm 包或 ad-hoc 注入扩展

### 体验与持久化

- **流式是头等公民**——大模型场景下流式即体验。内核以 token-level 事件流传递。
- **持久化默认 SQLite**（更普遍场景），但每个 frontend 可选 null（一次性）/ file（轻调试）/ 外挂。
- **零落盘选项必须保留**——CLI `--no-persist` / `huko run` 默认 ephemeral 是核心 use case。

### 代码约定

- **ESM + 显式 `.js` 后缀**：所有相对 import 写 `from "./xxx.js"`，即使源是 `.ts`。
- **TS 严格档**：`strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess`。
  - 可选字段**不**塞 `undefined`，用条件展开：`...(x !== undefined ? { x } : {})`
  - 数组下标返回 `T | undefined`，配可选链或显式守卫
  - `process.env["KEY"]` 永远是 `string | undefined`，必须 `?? "default"`
- **No god-file**：单文件单职责。文件超 ~300 行就该想想能不能拆。**这条同样适用于设计文档本身**。
- **No DOM in kernel**：`tsconfig` 不引 DOM lib。kernel 代码不应该能编译出 `document` / `window` 引用。

---

## 三、模块索引

✅ 已落地+文档齐 / 🔧 落地但文档过期需重写 / ⏳ 未实现

| 模块 | 路径 | 设计文档 | 一句话 | 状态 |
|---|---|---|---|---|
| 共享类型 | `shared/` | 见 [engine](./modules/engine.md) | EntryKind / TaskStatus / llm-protocol / **HukoEvent** | ✅ |
| LLM 调用层 | `server/core/llm/` | [llm](./modules/llm.md) | 协议适配 + 流式 + 工具调用双模式 | ✅ |
| Engine | `server/engine/` | [engine](./modules/engine.md) | SessionContext + TaskContext | ✅ |
| Task Loop | `server/task/task-loop.ts` | [task-loop](./modules/task-loop.md) | 主状态机 + interject + stop | ✅ |
| Pipeline | `server/task/pipeline/` | [pipeline](./modules/pipeline.md) | llm-call + tool-execute + context-manage | ✅ + ⏳ stub |
| Tools | `server/task/tools/` | [tools](./modules/tools.md) | 双注册 + ToolHandlerResult + coerceArgs + 策略；内置 message + web_fetch | ✅ |
| Roles | `server/roles/` + `server/services/build-system-prompt.ts` | [roles](./modules/roles.md) | 角色/persona 系统：markdown role + buildSystemPrompt + CLAUDE.md 注入；默认 `coding` | ✅ |
| Config | `server/config/` | [config](./modules/config.md) | 单一 config 子系统：DEFAULT_CONFIG + ~/.huko/config.json + project + env。所有 hardcoded tunable 收口于此 | ✅ |
| Resume | `server/task/resume.ts` | [resume](./modules/resume.md) | orphan 恢复：mark failed + 合成 tool_result 保配对 + elided entries 过滤 | ✅ |
| Persistence | `server/persistence/` | [persistence](./modules/persistence.md) | 两个接口：InfraPersistence (~/.huko/infra.db) + SessionPersistence (<cwd>/.huko/huko.db)；sqlite + memory 后端 | ✅ |
| DB schema | `server/db/` | [db](./modules/db.md) | 两份 SQLite schema：`schema/infra.ts` + `schema/session.ts`；分别 migration | ✅ |
| Security | `server/security/` | [security](./modules/security.md) | API key 解析：`<cwd>/.huko/keys.json` > env > `<cwd>/.env`；DB 永不持有 key | ✅ |
| Orchestrator | `server/services/` | [orchestrator](./modules/orchestrator.md) | 内核装配总枢（已接 Persistence） | ✅ |
| Daemon Gateway | `server/gateway.ts` | [gateway](./modules/gateway.md) | Socket.IO 网关 + 单一 "huko" wire event | ✅ |
| Daemon Routers | `server/routers/` | [routers](./modules/routers.md) | tRPC 控制接口（仅 daemon 用） | ✅ |
| Daemon Bootstrap | `server/core/app.ts` | [app](./modules/app.md) | Express + WS + tRPC 装配 | ✅ |
| HukoEvent 协议 | `shared/events.ts` | （待写专项 doc） | 语义事件 discriminated union（11 种类型） | ✅ |
| CLI | `server/cli/` | [cli](./modules/cli.md) | `run` (active session 默认) / `sessions` / `provider` / `model` / `keys` / `config`；后台 / 交互 ⏳ | ✅（v1） |
| Workstation | `server/workstation-manager/` | （未写） | 本地机器集成 | ⏳ |
| ~~Web Client~~ | ~~`client/`~~ | （已拆出） | 移到独立仓库 / 包 | 🚮 已删 |

---

## 四、相关文档

- `info.md` — WeavesAI 分析与 huko 设计意图（历史"为什么"）
- `architecture.md` — 本文：原则与索引
- `modules/*.md` — 各模块详细设计

---

## 五、新会话工作流

1. 读完本文，心里有"原则 + 模块全景"
2. 根据手头任务，打开对应 `modules/<name>.md` 加载细节
3. 跨模块工作时，分别加载相关模块文档
4. **改动单个模块的设计只动那个模块的文档**——避免连锁修改

---

## 六、新增模块/扩展的协议

- **新增内核模块**：写完代码 + 同时新建 `modules/<name>.md` + 在本文索引表加一行
- **新增内置 Persistence 实现**：放 `server/persistence/<name>/`，实现 `Persistence` 接口
- **新增内置 Tool**：放 `server/task/tools/<server|workstation>/<name>.ts`，调 `registerXxxTool`
- **新增 HukoEvent 类型**：在 `shared/events.ts` 联合类型中加一项，对应 frontend 各自更新渲染
- **新增 Frontend**（CLI 子命令、外部 web、IDE 插件）：消费 HukoEvent + 调 tRPC，**绝不修改 kernel**

文档与代码一起 review、一起合入。

---

## 七、当前进度（阶段性）

**✅ 已落地（kernel 基本可跑）**

- LLM 协议适配（OpenAI 协议 + OpenRouter preset）
- Engine（SessionContext 三段式 + TaskContext + 双层 abort）
- TaskLoop + pipeline（llm-call / tool-execute / context-manage stub）
- Tool 注册系统（双入口）
- SQLite 持久化（待抽象成 Persistence 接口的一种实现）
- Daemon HTTP/WS 装配（暂用，待按 HukoEvent 协议升级）

**🔧 进行中（当前迭代——参考 [agent-design-notes.md](./agent-design-notes.md)）**

按依赖顺序：

**✅ 当前迭代全部完成**：Promise.race 审计、SystemReminder collector、配对约束、Role 系统、Compaction Turn-atomic、Resume 三种 checkpoint

**✅ 近期完成**

- ~~Web 客户端拆出主仓~~
- ~~Persistence 接口抽象 + Memory / SQLite 两个内置实现~~
- ~~Orchestrator + routers 解耦 DB → 接 Persistence~~
- ~~HukoEvent 语义事件协议正式化~~
- ~~CLI 一次性模式 `huko run` (text / jsonl / json formatter)~~
- ~~FilePersistence (JSONL append-only event-sourced)~~（split 时退役）
- ~~Tool 系统 v2：ToolHandlerResult / coerceArgs / display / dangerLevel / platformNotes~~
- ~~首批内置 server tools：`message`（info+result）、`web_fetch`~~
- ~~CLI `sessions list/delete`、`--memory`、`--title`~~
- ~~`runMigrations()` 移进 SqlitePersistence constructor（架构清理）~~
- ~~`Persistence.close()` 必选化（架构清理）~~
- ~~CLAUDE.md 立"从根本解决"原则~~
- ~~WeavesAI 设计研究 doc（[agent-design-notes.md](./agent-design-notes.md)）~~
- ~~**Persistence 双拆**：`InfraPersistence` (~/.huko/infra.db) + `SessionPersistence` (<cwd>/.huko/huko.db)~~
- ~~**API key 解耦**：`providers.api_key_ref` + `server/security/keys.ts` 三层查找~~
- ~~**Active session per-cwd**：`<cwd>/.huko/state.json` + `huko run` 默认接续 + `sessions current/switch/new`~~
- ~~**Provider/Model/Keys CLI**：`huko provider/model/keys` 完整 CRUD~~
- ~~`<cwd>/.huko/.gitignore` 自动生成（默认排除 huko.db / keys.json / state.json）~~
- ~~删除 `HUKO_DB_PATH` env override（无消费者）~~

**⏳ 后续待建**

- 更多内置 server tools（`fs_read` / `fs_write` / `search` 等）
- CLI 后台模式（`huko start` 起 detached daemon, `huko send` 走 tRPC client）
- CLI 交互模式（`huko chat`：readline + send 循环）
- Tool 插件加载机制（npm convention + ad-hoc 注入）
- Skills 系统（LLM 自主激活的场景化指令包）
- Workstation 集成




