# DB 层

> `server/db/` —— SQLite 持久化（better-sqlite3 + Drizzle）。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/db/
  schema.ts                Drizzle schema 定义
  client.ts                better-sqlite3 + Drizzle 单例
  migrate.ts               Migration runner
  adapter.ts               PersistFn / UpdateFn / loaders / dbEntryToLLMMessage
  index.ts                 barrel
  migrations/
    0001_initial.sql       起手 schema
scripts/
  db-migrate.ts            CLI: npm run db:migrate
```

---

## 表结构（单用户、轻量、日志为主）

### 日志表（核心）

| 表 | 作用 |
|---|---|
| `chat_sessions` | 对话会话列表 |
| `tasks` | 每次任务执行记录 |
| `task_context` | **所有对话条目，单一事实来源** |

### 配置表（边缘）

| 表 | 作用 |
|---|---|
| `providers` | LLM API endpoints（`baseUrl + apiKey + protocol`） |
| `models` | provider 下的具体模型（modelId、display name、默认 thinkLevel/toolCallMode） |
| `app_config` | key-value 全局设置（如 `default_model_id`、`ui_theme`） |

**没有 `users` 表，没有 auth，没有 user_id 字段**——huko 是单用户系统。多用户化是未来的大重构，不预先付税。

---

## task_context 形态（关键）

```sql
CREATE TABLE task_context (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL,
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

**`session_id + session_type` 是 denormalised 的**——每条 entry 都重复 session 信息，让 `WHERE session_id = ? AND session_type = ?` 加载会话历史不用 JOIN。Sessions 跨多个 tasks 存活，这一冗余是值得的。

`metadata` 用 SQLite 的 JSON1 扩展（drizzle `mode: "json"`）。常见键：

- `toolCalls: ToolCall[]` — assistant turn 的工具调用结构（也作为 `LLMMessage.toolCalls` 字段还原）
- `attachments: UserAttachment[]` — user message 附件（`imageDataUrl` 在 persist 前已剥离）
- `usage: TokenUsage` — assistant turn 的 token 计数
- `thinking: string` — 流式累加期间的 reasoning 缓冲（最终落到 `thinking` 列）
- `severity` — status notice 的级别

---

## Adapter 层契约

`adapter.ts` 提供 engine 需要的依赖注入实现。**这层是 DB 与 engine 唯一的接触面。**

```typescript
makePersistEntry(db): PersistFn        // 给 SessionContext 用
makeUpdateEntry(db): UpdateFn          // 给 SessionContext 用
loadSessionLLMContext(db, sessionId, type): Promise<LLMMessage[]>
dbEntryToLLMMessage(row): LLMMessage | null   // 单一投影函数
```

orchestrator 在装配 SessionContext 时用这些 factory：

```typescript
new SessionContext({
  sessionId, sessionType,
  persist:  makePersistEntry(db),
  updateDb: makeUpdateEntry(db),
  emitter:  makeRoomEmitter(socketio, "chat:42"),
  initialContext: await loadSessionLLMContext(db, 42, "chat"),
});
```

### dbEntryToLLMMessage 是关键投影函数

DB 行 → LLMMessage 的转换。核心规则：

- `isLLMVisible(kind) === false`（即 StatusNotice）→ 返 null（不进 LLM context）
- assistant 行的 `metadata.toolCalls` → 还原成 `LLMMessage.toolCalls` 结构字段
- 把 `row.id` 挂到 `_entryId` 给 compaction / orphan recovery 用

这是 SessionContext.append() 写入逻辑的**逆操作**——symmetric。

---

## Migration

- 文件名 `NNNN_name.sql`，放 `migrations/` 目录
- 按文件名字典序应用（数字前缀务必 zero-pad）
- 每个文件在事务里执行，部分失败回滚
- 应用过的版本记在 `_migrations` 表

不用 drizzle-kit。SQLite 的 ALTER TABLE 受限严重（不能 drop column / rename column 直接做），很多变更需要 new-table-copy-data 套路，写成手工 SQL 比 drizzle-kit 自动生成更可控。

代价：`schema.ts` 与 SQL 的一致性靠作者自己把关。改一个列要改两处。TS 编译只能在 query code 引用不存在的列时才报错。

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

`adapter.ts` 的 metadata-merge 用 sync transaction 做 read-modify-write，避免并发写覆盖。

---

## 易踩的坑

- **不要**直接 `ALTER TABLE ... DROP COLUMN`——SQLite 旧版不支持，新版支持但有限制。drop column 通常用 new-table-copy-data。
- **不要**给 `db.transaction()` 传 async callback——事务会提前 commit。
- **不要**在 `schema.ts` 改了列却忘了写新 migration——TS 不报错，运行时 DB 操作才会炸。
- **不要**绕过 `dbEntryToLLMMessage` 投影函数自己拼 LLMMessage——会漏掉 toolCalls 还原 / `_entryId` 挂载。
- **不要**期望 better-sqlite3 是异步的——它就是同步的，async wrapper 只是 ergonomics。
- **不要**在已发布的 migration 文件里改 SQL——加新 migration 文件。0001 可以改是因为 huko 还没首次发布。

---

## 验证

```bash
npm run db:migrate
# 创建 huko.db（默认）或 $HUKO_DB_PATH 指定路径
# 应用 0001_initial.sql

sqlite3 huko.db ".schema"
# 应看到 6 张表 + _migrations
```

---

## 见

- [engine.md](./engine.md) — `PersistFn` / `UpdateFn` 的接口契约
- [task-loop.md](./task-loop.md) — orchestrator 怎么把 adapter 接进 SessionContext
