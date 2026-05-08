# Persistence

> `server/persistence/` —— 持久化抽象层。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/persistence/
  types.ts             Persistence 接口 + Row 类型 + Input 类型 + 错误类
  sqlite.ts            SqlitePersistence —— 包装 server/db/，full impl
  memory.ts            MemoryPersistence —— 全功能内存实现
  file.ts              FilePersistence —— JSONL append-only event-sourced
  index.ts             barrel
```

---

## 职责

Persistence 是 huko kernel 与**任何**存储后端的唯一接触面。

- Kernel（engine / orchestrator / routers）**只**依赖 `Persistence` 接口
- 具体后端（SQLite、内存、未来的 Postgres / Redis）实现这个接口
- 切换后端 = 换一个实现，零 kernel 改动

---

## 两个 Tier

```
┌────────────────────────────────────────────┐
│  Tier 1（kernel 必需）                     │
│  ───────────────────────                   │
│  entries.persist                           │
│  entries.update                            │
│  entries.loadLLMContext                    │
│  entries.listForSession                    │
│                                            │
│  → SessionContext 用前两个                 │
│  → resume 用第三个                         │
│  → daemon UI 用第四个                      │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│  Tier 2（daemon / 多会话特性必需）         │
│  ──────────────────────────────            │
│  sessions.{create, list, get, delete}      │
│  tasks.{create, update, get}               │
│  providers.{list, create, update, delete}  │
│  models.{list, create, delete, resolve}    │
│  config.{get, set, list, *DefaultModelId}  │
└────────────────────────────────────────────┘
```

后端可以**只**实现 Tier 1（一次性 / 嵌入场景），Tier 2 抛 `PersistenceUnsupportedError`。但内置的 Memory + SQLite 都实现 Tier 1 + Tier 2 全套——保持替换性。

---

## 内置实现

| 实现 | 适用 | 落盘? | 进程退出后? | 形态 |
|---|---|---|---|---|
| `MemoryPersistence` | 一次性 CLI / 测试 / 沙盒 | ❌ | 全丢 | 内存 Map |
| `FilePersistence` | 轻量长期 / 调试 / 可外送日志服务 | ✅ JSONL | 持久 | event-sourced 一行一 op，启动 replay |
| `SqlitePersistence` | daemon 默认 / 大量并发 | ✅ huko.db | 持久 | 关系型，索引检索 O(log N) |
| 外部包（未来） | Postgres / Redis / S3 / ... | 视实现 | 视实现 | 视实现 |

外部实现按 npm 包 `huko-persistence-<name>` 命名约定发布，导出实现 `Persistence` 的 class。barrel 不需改。

---

## FilePersistence (JSONL append-only)

每个 mutation 是一行 JSON "op"。状态由启动时 replay 文件重建。读全部 in-memory。

```typescript
import { FilePersistence } from "./persistence/index.js";

const persistence = new FilePersistence({
  path: process.env.HUKO_LOG_PATH ?? "./huko.jsonl",
  fsync: false,  // true 时每 op 后强制 flush，durability 优先；默认靠 OS 缓存
});
```

**Op 类型**（11 种）：

```
session.create / session.delete
task.create    / task.update
entry.append   / entry.update
provider.create / provider.update / provider.delete
model.create   / model.delete
config.set
```

**Cascade 优化**：`session.delete` 只写一行——replay/apply 时自动联动删 tasks + 它们的 entries。日志保持紧凑。

**为什么要这个**：
- 调试友好：`cat huko.jsonl` 看到完整历史
- 可外送：每行直接送 fluentd / kafka / S3 sync 之类
- Crash safe：append-only 写不破坏前面的历史
- Event-sourced 与 HukoEvent 协议契合（虽然 op 不是 HukoEvent，但形态思路一致）
- 无 schema migration：op 自带形态

**取舍 vs SQLite**：
- 启动 O(N) replay；SQLite 启动 O(1)
- 无索引 → 列出所有 sessions 是 Map 全扫；SQLite 有 B-tree
- 单写并发 OK；多 writer 进程并发 = 乱（O_APPEND 在 PIPE_BUF 以下原子，但混进度量难调）
- 适合**几百 sessions 量级的轻量持久化**；不适合 multi-tenant 大规模

**容错**：replay 时坏行（JSON parse 失败 / op 不识别）skip + stderr warn。最后一行可能因 crash 半截，无法 parse 直接跳。

**默认路径**：`opts.path` 必填。约定 `$HUKO_LOG_PATH` 或 `./huko.jsonl`。

---

## SessionContext 的解耦设计

SessionContext 不直接依赖 `Persistence` 接口，而是吃**两个函数 shape**：

```typescript
new SessionContext({
  persist: persistence.entries.persist,     // PersistFn
  updateDb: persistence.entries.update,     // UpdateFn
  emitter,
  initialContext,
});
```

orchestrator 在装配 SessionContext 时从 `persistence.entries` 解构出来。这样 SessionContext 单元测试可以塞两个 mock 函数，不需要造完整 Persistence。

---

## 用法

### Daemon 模式

```typescript
import { SqlitePersistence } from "./persistence/index.js";
import { runMigrations } from "./db/index.js";

runMigrations();
const persistence = new SqlitePersistence();
const orchestrator = new TaskOrchestrator({ persistence, emitterFactory });
```

### 一次性 CLI

```typescript
import { MemoryPersistence } from "./persistence/index.js";

const persistence = new MemoryPersistence();
const orchestrator = new TaskOrchestrator({ persistence, emitterFactory });
// 跑完 task → 进程退出 → 一切清空
```

### 轻量长期 / 调试

```typescript
import { FilePersistence } from "./persistence/index.js";

const persistence = new FilePersistence({ path: "./huko.jsonl" });
const orchestrator = new TaskOrchestrator({ persistence, emitterFactory });
// 关闭时 persistence.close()
```

### 测试

```typescript
import { MemoryPersistence } from "@/persistence/index.js";

const persistence = new MemoryPersistence();
const sessionId = await persistence.sessions.create({ title: "test" });
const taskId = await persistence.tasks.create({ ... });
// ...assertions
```

---

## 关键约定

- **方法都是 async**——即使底层 better-sqlite3 是同步的也包成 Promise，统一调用风格、未来换异步后端无痛
- **不抛对象，抛 Error**——`PersistenceUnsupportedError` / `Error` 等，让 catch 一致
- **删除是 cascade**——`sessions.delete(id)` 自动清掉 owned tasks + entries（FK CASCADE 或显式遍历）
- **Row 类型独立于 Drizzle**——接口里的 `TaskRow` 是接口契约，不是 Drizzle 的 `$inferSelect`。SqlitePersistence 内部做映射

---

## 易踩的坑

- **不要**让 kernel 代码直接 import drizzle / better-sqlite3——那是 SqlitePersistence 的内部细节。kernel 只 import `Persistence` 接口。
- **不要**把 SQLite 特有概念（事务、prepared statement、WAL）泄漏到接口里——接口要中立。
- **不要**忘了 SessionContext 的 `update.mergeMetadata` 语义——shallow merge over existing。所有实现都要遵守。
- **不要**在 MemoryPersistence / FilePersistence 里用真 `drizzle` 的 `$inferSelect` 类型——它们各是独立的 Map / op-log 实现，造自己的 row 形态即可。
- **不要**让 FilePersistence 多 writer 进程同时跑——单写就好。多读 OK。

---

## 验证

接口齐 + 三个实现 type-check 通过：

```bash
npm run check
```

---

## 见

- [engine.md](./engine.md) —— SessionContext 怎么消费 `entries.persist` / `entries.update`
- [orchestrator.md](./orchestrator.md) —— 装配点
- [db.md](./db.md) —— 当前 SQLite schema 的细节（SqlitePersistence 包装它）
