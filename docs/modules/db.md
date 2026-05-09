# DB 层

> `server/db/` —— SQLite 持久化（better-sqlite3 + Drizzle）。
> **两个 DB**：`~/.huko/infra.db` + `<cwd>/.huko/huko.db`。
>
> 见 [架构总览](../architecture.md) 和 [persistence.md](./persistence.md)。

---

## 文件

```
server/db/
  schema/
    infra.ts                providers / models / app_config 表
    session.ts              chat_sessions / tasks / task_context 表
    index.ts                re-export 两个 namespace
  migrations/
    infra/
      0001_initial.sql      infra DB 起手 schema
    session/
      0001_initial.sql      session DB 起手 schema
  migrate.ts                Migration runner（按 handle + dir 调用）
  adapter.ts                PersistFn / UpdateFn / loaders / dbEntryToLLMMessage
                            （只针对 session DB）
  index.ts                  barrel
scripts/
  db-migrate.ts             CLI: npm run db:migrate
```

`server/db/client.ts` 已**退役**——不再有全局 Drizzle 单例。每个 SQLite
persistence backend 自己 open + 自己跑 migration。

---

## 表结构（按 DB 分）

### 用户全局：`~/.huko/infra.db`

| 表 | 作用 |
|---|---|
| `providers` | LLM API endpoints（`baseUrl + protocol + api_key_ref`） |
| `models` | provider 下的具体 model（`modelId`、display name、默认 thinkLevel/toolCallMode） |
| `app_config` | key-value 全局设置（`default_model_id` 等） |

**`providers.api_key_ref` 不是真 key**——是逻辑名（如 `"openrouter"`），运行时
由 `server/security/keys.ts` 三层查找解析。详见 [security.md](./security.md)。

### 项目级：`<cwd>/.huko/huko.db`

| 表 | 作用 |
|---|---|
| `chat_sessions` | 对话会话列表 |
| `tasks` | 每次任务执行记录 |
| `task_context` | **所有对话条目，单一事实来源** |

**没有 `users` 表，没有 auth，没有 user_id 字段**——huko 是单用户系统。

---

## task_context 形态（核心）

```sql
CREATE TABLE task_context (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL,
  session_type  TEXT NOT NULL,           -- "chat" | "agent"
  kind          TEXT NOT NULL,           -- EntryKind 字符串值
  role          TEXT NOT NULL,           -- system | user | assistant | tool
  content       TEXT NOT NULL,
  tool_call_id  TEXT,
  thinking      TEXT,
  metadata      TEXT,                    -- JSON：toolCalls/attachments/usage 等
  created_at    INTEGER NOT NULL
);
```

**`session_id + session_type` 是 denormalised 的**——每条 entry 都重复
session 信息，让 `WHERE session_id = ? AND session_type = ?` 加载会话历史
不用 JOIN。Sessions 跨多个 tasks 存活，这一冗余是值得的。

`metadata` 用 SQLite 的 JSON1 扩展（drizzle `mode: "json"`）。常见键：

- `toolCalls: ToolCall[]` — assistant turn 的工具调用结构
- `attachments: UserAttachment[]` — user message 附件（`imageDataUrl` 在
  persist 前已剥离）
- `usage: TokenUsage` — assistant turn 的 token 计数
- `severity` — status notice 的级别
- `reminderReason` / `elidedEntryIds` — system reminder 元数据（compaction 用）

---

## Adapter 层契约（只针对 session DB）

`adapter.ts` 提供 engine 需要的依赖注入实现。**这层是 session DB 与 engine
唯一的接触面**。infra DB 没有 adapter 层——它的消费者只有 orchestrator 和
provider/model CLI，直接用 InfraPersistence 接口就够。

```typescript
type SessionDb = BetterSQLite3Database<typeof sessionSchema>;

makePersistEntry(db: SessionDb): PersistFn
makeUpdateEntry(db: SessionDb): UpdateFn
loadSessionLLMContext(db: SessionDb, sessionId, type): Promise<LLMMessage[]>
dbEntryToLLMMessage(row): LLMMessage | null   // 单一投影函数
```

orchestrator 在装配 SessionContext 时用这些 factory（见 SqliteSessionPersistence
的 `entries.persist` / `entries.update` 字段）。

### dbEntryToLLMMessage 是关键投影函数

DB 行 → LLMMessage 的转换。核心规则：

- `isLLMVisible(kind) === false`（即 StatusNotice）→ 返 null（不进 LLM context）
- assistant 行的 `metadata.toolCalls` → 还原成 `LLMMessage.toolCalls` 结构字段
- 把 `row.id` 挂到 `_entryId` 给 compaction / orphan recovery 用

这是 `SessionContext.append()` 写入逻辑的**逆操作**——symmetric。

---

## Migration

- 文件名 `NNNN_name.sql`，分别放 `migrations/infra/` 和 `migrations/session/`
- 按文件名字典序应用（数字前缀务必 zero-pad）
- 每个文件在事务里执行，部分失败回滚
- 应用过的版本记在各自 DB 的 `_migrations` 表（每个 DB 一份独立的）

```typescript
runMigrations(sqlite, "/abs/path/to/migrations/infra");   // infra
runMigrations(sqlite, "/abs/path/to/migrations/session"); // session
```

`SqliteInfraPersistence` / `SqliteSessionPersistence` 在 constructor 里自
己调，bootstrap 不参与。

不用 drizzle-kit。SQLite 的 ALTER TABLE 受限严重，很多变更需要
new-table-copy-data 套路，写成手工 SQL 更可控。代价：`schema/*.ts` 与 SQL 的
一致性靠作者自己把关。

---

## Transaction 注意事项

`db.transaction(...)` 是**同步**的——better-sqlite3 不支持 async transaction。

```typescript
// ✅ 正确
db.transaction((tx) => {
  const existing = tx.select(...).get();
  tx.update(...).set({...}).where(...).run();
});

// ❌ 错误：async callback 会让事务在 await 之前就 commit
db.transaction(async (tx) => {
  const existing = await someAsyncOp();   // 事务此时已经 commit
  tx.update(...);                         // 不在事务里
});
```

`adapter.ts` 的 metadata-merge 用 sync transaction 做 read-modify-write，避免
并发写覆盖。

---

## 易踩的坑

- **不要**把 infra schema 的表加到 session migrations 子目录（反之亦然）——
  会跑到错的 DB 上，建错表 + 后续 reference 失败
- **不要**直接 `ALTER TABLE ... DROP COLUMN`——SQLite 限制多。drop column
  用 new-table-copy-data
- **不要**给 `db.transaction()` 传 async callback——事务会提前 commit
- **不要**在 `schema/*.ts` 改了列却忘了写新 migration——TS 不报错，运行时
  DB 操作才会炸
- **不要**绕过 `dbEntryToLLMMessage` 投影函数自己拼 LLMMessage——会漏掉
  toolCalls 还原 / `_entryId` 挂载
- **不要**期望 better-sqlite3 是异步的——它就是同步的，async wrapper 只是
  ergonomics
- **不要**在 0001 之后新加列就改 0001——加新 migration 文件 `0002_*.sql`

---

## 验证

```bash
npm run db:migrate
# 创建/迁移：~/.huko/infra.db + <cwd>/.huko/huko.db
# 各自跑各自的 0001_initial.sql

sqlite3 ~/.huko/infra.db ".schema"
# 应看到 providers / models / app_config / _migrations

sqlite3 .huko/huko.db ".schema"
# 应看到 chat_sessions / tasks / task_context / _migrations
```

---

## 见

- [persistence.md](./persistence.md) — InfraPersistence / SessionPersistence 接口契约
- [security.md](./security.md) — 为什么 api_key_ref 不是真 key
- [engine.md](./engine.md) — `PersistFn` / `UpdateFn` 的接口契约
