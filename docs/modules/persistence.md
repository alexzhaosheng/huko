# Persistence

> `server/persistence/` —— 持久化抽象层。**两个接口、两个 DB、两个 scope**。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 大方向

历史上 huko 只有**一个** `Persistence` 接口、**一个** `<cwd>/huko.db`，把
provider/API key（用户身份）跟 sessions/tasks/entries（项目对话）混存。
这条路走不通——切项目就要重新配 key、DB 紧贴源码、API key 风险蹭进 git
仓库。

新设计**按 scope 切两份**：

```
~/.huko/                      用户全局
  infra.db                    providers / models / app_config（默认 model）
  keys.json                   API keys（chmod 600，永不入 DB）
  config.json                 已有
  roles/                      已有

<cwd>/.huko/                  项目级
  huko.db                     sessions / tasks / entries（这个项目的对话）
  keys.json                   API keys 项目覆盖（gitignored）
  state.json                  active session id
  config.json                 已有
  roles/                      已有
  .gitignore                  自动生成
```

| 类别 | 接口 | 落地 |
|---|---|---|
| 用户身份（providers / models / 系统默认） | `InfraPersistence` | `~/.huko/infra.db` |
| 项目对话（sessions / tasks / entries） | `SessionPersistence` | `<cwd>/.huko/huko.db` |

---

## 文件

```
server/persistence/
  types.ts             InfraPersistence + SessionPersistence + Row 类型
  sqlite-infra.ts      SqliteInfraPersistence  (~/.huko/infra.db)
  sqlite-session.ts    SqliteSessionPersistence (<cwd>/.huko/huko.db)
  sqlite.ts            兼容 barrel——re-export 上面两个
  memory.ts            MemoryInfraPersistence + MemorySessionPersistence
  file.ts              已退役（split 时移除——代码可从 git 历史恢复）
  index.ts             顶层 barrel
```

---

## 接口边界

**InfraPersistence**：
```typescript
providers: { list, create, update, delete }
models:    { list, create, delete, resolveConfig }
config:    { get, set, list, getDefaultModelId, setDefaultModelId }
close()
```

**SessionPersistence**：
```typescript
entries:  { persist, update, loadLLMContext, listForSession }
sessions: { create, list, get, delete }
tasks:    { create, update, get, listNonTerminal }
close()
```

orchestrator 持有两份；CLI 视情况开一份或两份；router 按 procedure 分摊。
**不再有**单一 `Persistence` 接口。

---

## API key 不进 DB

`providers.api_key_ref` 列存的是**逻辑名**（如 `"openrouter"`），不是 key。
运行时由 `server/security/keys.ts` 三层查找：

```
1. <cwd>/.huko/keys.json         项目显式（最高）
2. process.env.<REF>_API_KEY     shell / 系统
3. <cwd>/.env                    项目 dotenv（最低）
```

env 变量命名约定：`<REF.toUpperCase()>_API_KEY`，例如 ref `openrouter` 找
`OPENROUTER_API_KEY`。

后果：**两个 DB 都不含敏感数据**。备份、复制、把 `.huko/huko.db` 入 git
（你大概不想这样，默认 `.gitignore` 已把它排除，但理论上）—— 都不会泄漏 key。

详见 [security.md](./security.md)。

---

## 内置实现

| 实现 | 接口 | 落盘 | 用途 |
|---|---|---|---|
| `SqliteInfraPersistence` | InfraPersistence | ~/.huko/infra.db | 默认 |
| `SqliteSessionPersistence` | SessionPersistence | `<cwd>`/.huko/huko.db | 默认 |
| `MemoryInfraPersistence` | InfraPersistence | ❌ | --memory / 测试 |
| `MemorySessionPersistence` | SessionPersistence | ❌ | --memory / 测试 |

每个 SQLite 实现的 constructor：
1. `mkdir -p` 父目录
2. 打开 better-sqlite3 + drizzle
3. 跑自己 migration 子目录（`server/db/migrations/{infra,session}/*.sql`）
4. （仅 session 默认路径）写入 `<cwd>/.huko/.gitignore` 防止误提交

各管各的连接，互不知情。换路径用 `opts.dbPath`（测试 / 自定义布局）。

---

## SessionContext 的解耦

SessionContext 不直接依赖 `SessionPersistence` 接口，而是吃**两个函数 shape**：

```typescript
new SessionContext({
  persist:  session.entries.persist,    // PersistFn
  updateDb: session.entries.update,     // UpdateFn
  emitter,
  initialContext,
});
```

orchestrator 在装配 SessionContext 时从 `session.entries` 解构出来。
SessionContext 单元测试可以塞两个 mock 函数，不需要造完整 SessionPersistence。

---

## 用法

### Daemon / 持久 CLI

```typescript
import {
  SqliteInfraPersistence,
  SqliteSessionPersistence,
} from "./persistence/index.js";

const infra = new SqliteInfraPersistence();
const session = new SqliteSessionPersistence({ cwd: process.cwd() });
const orchestrator = new TaskOrchestrator({ infra, session, emitterFactory });
```

各 backend 自己跑 migration，bootstrap 不知道也不需要知道。

### 一次性 / `--memory`

```typescript
import {
  MemoryInfraPersistence,
  MemorySessionPersistence,
} from "./persistence/index.js";

const infra = new MemoryInfraPersistence();      // 启动时从磁盘 seed providers
const session = new MemorySessionPersistence(); // 永远空
const orchestrator = new TaskOrchestrator({ infra, session, emitterFactory });
```

CLI `--memory` 模式：bootstrap 用 SqliteInfraPersistence 短开一下，把
providers / models / default model 拷进 MemoryInfra，然后关闭磁盘连接。
session 直接用 MemorySession（不读不写）。

### 测试

```typescript
import {
  MemoryInfraPersistence,
  MemorySessionPersistence,
} from "@/persistence/index.js";

const infra = new MemoryInfraPersistence();
const session = new MemorySessionPersistence();
const sessionId = await session.sessions.create({ title: "test" });
```

---

## 关键约定

- **方法都是 async**——即使 better-sqlite3 是同步的也包成 Promise，统一调用风格
- **删除 cascade**——`sessions.delete(id)` 自动清掉 owned tasks + entries（FK CASCADE 或显式遍历）
- **Row 类型独立于 Drizzle**——接口里的 `TaskRow` / `ProviderRow` 是接口契约，不是 Drizzle 的 `$inferSelect`。SQLite 实现内部做映射
- **`apiKeyRef` 永不是真 key**——一个字符串 ref 名，运行时查表

---

## 易踩的坑

- **不要**在 kernel 代码直接 import drizzle / better-sqlite3——那是 SQLite 实现的内部细节
- **不要**把 SQLite 特有概念（事务、prepared statement、WAL）泄漏到接口
- **不要**忘了 SessionContext 的 `update.mergeMetadata` 语义——shallow merge over existing
- **不要**用 `apiKeyRef` 当 key 直接传给 LLM SDK——必须先过 `resolveApiKey`
- **不要**让 `MemoryInfra` 和 `MemorySession` 共享 id 计数——它们是独立 backend
- **不要**期望 `<cwd>/.huko/huko.db` 跨 cwd 共享——cwd 不同 = 不同 DB

---

## 验证

```bash
npx tsc --noEmit
```

---

## 见

- [security.md](./security.md) —— keys.json / env / .env 三层查找细节
- [orchestrator.md](./orchestrator.md) —— 怎么把 infra + session + emitterFactory 接起来
- [engine.md](./engine.md) —— SessionContext 消费 `entries.persist` / `entries.update`
- [db.md](./db.md) —— SQLite schema（split 后两份）
