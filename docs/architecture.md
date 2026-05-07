# huko 架构总览

> 工程约束 + 模块索引。新会话先读这一份，然后按需打开对应模块文档。
>
> **本文应该保持精简**——只装跨模块原则与索引。模块特定的设计、契约、坑放在 `modules/<name>.md`。

---

## 一、基本原则

跨模块的契约。新模块设计前先扫一遍。

### 依赖与边界

- **Engine 零基础设施依赖**：`server/engine/` 永远不直接 import `db` / `socket.io` / Express。基础设施通过构造函数注入（`PersistFn` / `UpdateFn` / `Emitter`），engine 单元可独立测试。
- **`server/` 不被 `client/` import**：前后端共享类型走 `shared/`，运行时通信走 tRPC + WebSocket。

### Context 写入垄断

- **SessionContext 是 context 唯一写入入口**。任何绕开它直接写 DB / 推 WS / 动 `llmContext` 数组的代码都是 bug。
- **`isLLMVisible(kind)` 是哪些 entry 进 LLM context 的单一决策点**。调用方不传 dispatch flag，不写条件判断。
- **System prompt 不进 session**——它是 task 级配置，由 pipeline 在 LLM 调用时即时拼接。

### 注册与扩展

- **副作用注册模式**：协议 adapter、工具，都走集中显式注册（`register.ts` / `tools/index.ts`）。**不**用模块顶层自注册（不易追踪）。
- **新增功能前先问自己**：这是**分发点**（参与运行时分发，要进 registry）还是**工厂帮手**（只是命名好的便利封装）？
  - 是抽象：`ProtocolAdapter`、`SessionContext.append/...`、`EntryKind + isLLMVisible`、`TaskContext` 字段、`TaskLoop` 状态机、`registerServerTool`
  - 是糖：`ProviderPreset`、`withOpenRouter()`、`injectToolsAsXml`、`LLMHttpError`、私有 helper

### 体验与持久化

- **流式是头等公民**——大模型场景下流式即体验。从设计第一天就要支持，**不**当成后期优化。
- **持久化用 SQLite**（better-sqlite3）：开发零配置，文件即数据库。Schema 走 Drizzle ORM。

### 代码约定

- **ESM + 显式 `.js` 后缀**：所有相对 import 写 `from "./xxx.js"`，即使源是 `.ts`。`tsconfig.moduleResolution: "bundler"` 解析。
- **TS 严格档**：`strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess`。
  - 可选字段**不**塞 `undefined`，用条件展开：`...(x !== undefined ? { x } : {})`
  - 数组下标返回 `T | undefined`，配可选链或显式守卫
  - `process.env["KEY"]` 永远是 `string | undefined`，必须 `?? "default"`
- **No god-file**：单文件单职责。文件超 ~300 行就该想想能不能拆。**这条同样适用于设计文档本身**——一个模块一份文档。

### 跨模块禁忌

- **不要**在 LLM messages 里给 provider 发 `_entryId`——这是私有反向引用字段。
- **不要**让 client（浏览器）import `server/` 任何东西——会把 Node 专属代码（`process.env`、native 模块）拉进 bundle。

---

## 二、模块索引

| 模块 | 路径 | 设计文档 | 一句话 | 状态 |
|---|---|---|---|---|
| 共享类型 | `shared/` | 见 [engine](./modules/engine.md) | EntryKind / TaskStatus / WS payloads | ✅ |
| LLM 调用层 | `server/core/llm/` | [llm](./modules/llm.md) | 协议适配 + 流式 + 工具调用双模式 | ✅ |
| Engine | `server/engine/` | [engine](./modules/engine.md) | SessionContext + TaskContext | ✅ |
| Task Loop | `server/task/task-loop.ts` | [task-loop](./modules/task-loop.md) | 主状态机 + interject + stop | ✅ |
| Pipeline | `server/task/pipeline/` | [pipeline](./modules/pipeline.md) | llm-call + tool-execute + context-manage | ✅ + ⏳ stub |
| Tools | `server/task/tools/` | [tools](./modules/tools.md) | 双注册入口 + 自注册流程 | ✅（registry）/ ⏳（具体 tool） |
| Resume | `server/task/resume.ts` | [task-loop](./modules/task-loop.md) | orphan 恢复 | ⏳ stub |
| DB | `server/db/` | [db](./modules/db.md) | SQLite schema + migrations + adapter | ✅ |
| Orchestrator | `server/services/` | [orchestrator](./modules/orchestrator.md) | DB + emitter + engine 装配总枢 | ✅ |
| Gateway | `server/gateway.ts` | （未写） | Socket.IO 网关 | ⏳ |
| Routers | `server/routers/` | （未写） | 按领域拆分的 tRPC | ⏳ |
| Server 启动 | `server/core/app.ts` | （未写） | Express + Vite middleware | ⏳ |
| Workstation | `server/workstation-manager/` | （未写） | 本地机器集成 | ⏳ |
| Client | `client/` | （未写） | React + Vite + tRPC client | ⏳ |

**符号**：✅ 落地+文档齐 / ⏳ 未实现或 stub

---

## 三、相关文档

- `info.md` — WeavesAI 分析与 huko 设计意图（历史"为什么"）
- `architecture.md` — 本文：原则与索引
- `modules/*.md` — 各模块详细设计

---

## 四、新会话工作流

1. 读完本文，心里有"原则 + 模块全景"
2. 根据手头任务，打开对应 `modules/<name>.md` 加载细节
3. 跨模块工作时，分别加载相关模块文档
4. **改动单个模块的设计只动那个模块的文档**——避免连锁修改

---

## 五、新增模块的协议

- 写完代码后，**同时**新建 `modules/<name>.md`
- 在本文的"模块索引"表里加一行
- 模块文档应该至少包含：文件列表、公开契约、关键设计点、扩展手册（如适用）、易踩的坑、验证方法、相关模块链接

文档与代码一起 review、一起合入。
