# Routers (tRPC)

> `server/routers/` —— HTTP API 入口，按领域拆分。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/routers/
  trpc.ts          tRPC builder bootstrap（router / publicProcedure）
  context.ts       Ctx 类型（{ db, orchestrator }）
  index.ts         appRouter 根 + AppRouter 类型导出
  chat.ts          chat.* —— sessions + sendMessage
  task.ts          task.* —— stop / get
  provider.ts      provider.* —— LLM API endpoints CRUD
  model.ts         model.* —— 具体模型 CRUD + setDefault / getDefault
  config.ts        config.* —— app_config 通用 key-value
```

---

## 设计原则

- **按领域拆文件**——避免 WeavesAI 那种单文件 routers.ts 臃肿
- **routers 是薄层**：参数校验（zod） + auth（暂无） + 转发到 orchestrator / DB
- **业务逻辑在 orchestrator / engine**，不在 router 里
- **mutation 立刻返回**，不阻塞等任务跑完——客户端订阅 WS room 拿后续事件

---

## 现有 procedure 一览

### `chat.*`
- `create({ title? })` → `{ id }` —— 新建 chat session
- `list()` → `ChatSession[]` —— 列出会话（按 updatedAt desc）
- `get({ id })` → `{ session, entries }` —— 详情 + 完整 entry 历史
- `sendMessage({ chatSessionId, content, modelId? })` → `{ taskId, interjected }`
  - 内部走 `orchestrator.sendUserMessage`
  - **完成事件通过 WS 收**（`task:done` / `task:failed` / `task:stopped` / `task:error`）

### `task.*`
- `stop({ id })` → `{ stopped: boolean }` —— 硬停。stopped=false 表示任务已经不活了
- `get({ id })` → task 行

### `provider.*`
- `list()` → providers
- `create({ name, protocol, baseUrl, apiKey, defaultHeaders? })` → `{ id }`
- `update({ id, ...patch })` → `{ ok }`
- `delete({ id })` → `{ ok }`

### `model.*`
- `list()` → models inner-joined 上 provider name + protocol
- `create({ providerId, modelId, displayName?, defaultThinkLevel?, defaultToolCallMode? })` → `{ id }`
- `delete({ id })` → `{ ok }`
- `setDefault({ modelId })` → `{ ok }` —— upsert `app_config.default_model_id`
- `getDefault()` → `{ modelId: number | null }`

### `config.*`
- `get({ key })` → `{ value: unknown | null }`
- `set({ key, value })` → `{ ok }` —— upsert
- `list()` → 全部 app_config 行

---

## 添加一个新领域

1. 写 `server/routers/<domain>.ts`，里面 `export const <domain>Router = router({...})`
2. 在 `index.ts` 里 `import` 进来 + 加到 appRouter 对象
3. 客户端立即拿到类型补全（通过 `import type { AppRouter }`）

不需要改其他任何文件。

---

## 客户端类型推断

```typescript
// client side:
import type { AppRouter } from "../../server/routers/index.js";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

const trpc = createTRPCProxyClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc" })],
});

const result = await trpc.chat.sendMessage.mutate({
  chatSessionId: 1,
  content: "hi",
});
// result: { taskId: number; interjected: boolean }  ← 自动推断
```

`AppRouter` 是从 server 静态 import 的**类型**，运行时代码不会被打包到客户端 bundle——TypeScript 自动剥离。

---

## Context 注入

```typescript
// app.ts
app.use("/api/trpc", createExpressMiddleware({
  router: appRouter,
  createContext: () => ({ db, orchestrator }),
}));
```

每次请求 `createContext()` 同步返回同一个 `{ db, orchestrator }`——所有 procedure 都能取到这两个单例。

未来要加 auth：在 ctx 加 `user`，在 trpc.ts 加 `protectedProcedure` middleware 检查。**当前单用户，无需此**。

---

## Mutation vs Query

| 类型 | 用途 | huko 现有 |
|---|---|---|
| `mutation` | 修改状态 | sendMessage / stop / create / update / delete / setDefault / set |
| `query` | 只读 | list / get / getDefault |

约定俗成，影响 client 端 cache 行为（query 可缓存重用，mutation 总是触发刷新）。

---

## 易踩的坑

- **不要**在 router 里塞业务逻辑——薄到几乎只有参数转发。如果 router 函数超过 30 行，多半该抽到 orchestrator / engine。
- **不要**在 mutation 里 `await orchestrator.sendUserMessage(...).completion`——会把 HTTP 请求挂住到任务跑完。客户端通过 WS 监听完成事件。
- **不要**在 router 里直接 `import "../db/client.js"` 用全局 db——通过 `ctx.db` 用，保持可测试性。
- **不要**返回不可序列化的对象（Promise / 函数 / class instance）——tRPC 要 `JSON.stringify`，会丢字段。

---

## 验证

```bash
npm run dev
curl http://localhost:3000/api/trpc/chat.list
# 期望 JSON: { "result": { "data": [...] } }

curl -X POST http://localhost:3000/api/trpc/chat.create \
  -H "Content-Type: application/json" \
  -d '{"title":"test"}'
```

---

## 见

- [orchestrator.md](./orchestrator.md) —— mutation 的实际去处
- [db.md](./db.md) —— 各 router 用的表
- [gateway.md](./gateway.md) —— mutation 触发的事件从哪里推
- [app.md](./app.md) —— routers 在哪里 mount
