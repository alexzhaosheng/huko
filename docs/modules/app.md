# Server App (Express bootstrap)

> `server/core/app.ts` —— 进程启动入口。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/core/app.ts        Express + http.Server + Socket.IO + tRPC 装配
```

---

## Boot 顺序

```
1. runMigrations()                                   DB schema 准备好（幂等）
2. const app = express(); app.use(express.json())    Express + body parser
3. const httpServer = http.createServer(app)         Socket.IO 要挂到 plain http server
4. const gateway = createGateway(httpServer)         Socket.IO + emitterFactory
5. const orchestrator = new TaskOrchestrator({       engine 装配点
     db,
     emitterFactory: gateway.emitterFactory,
   })
6. app.use("/api/trpc", createExpressMiddleware({    tRPC mount
     router: appRouter,
     createContext: () => ({ db, orchestrator }),
   }))
7. app.get("/health"), app.get("/")                  健康检查 + landing
8. httpServer.listen(PORT, HOST)                     起飞
```

**顺序不能乱**：

- migration 必须在所有 DB 操作前
- gateway 要在 orchestrator 前（orchestrator 构造函数吃 emitterFactory）
- tRPC 在 gateway 之后（route handler 闭包里用 orchestrator）
- listen 最后

---

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | 3000 | HTTP 端口 |
| `HOST` | 127.0.0.1 | 绑定地址（本地优先） |
| `HUKO_DB_PATH` | `./huko.db` | SQLite 文件路径 |
| `OPENROUTER_APP_URL` | `https://huko.dev` | OpenRouter HTTP-Referer 头 |
| `OPENROUTER_APP_TITLE` | `Huko` | OpenRouter X-Title 头 |
| `NODE_ENV` | `development` | dev / production |

dev / build / start 脚本走 `cross-env` 注入 NODE_ENV，跨平台兼容。

---

## URL 一览（运行时）

| URL | 内容 |
|---|---|
| `GET /` | 占位 landing 页（HTML，将被 React UI 替换） |
| `GET /health` | `{ ok, service, migrationsApplied, migrationsSkipped }` |
| `* /api/trpc/*` | tRPC 路由（routers/index.ts 下所有 procedure） |
| `* /socket.io/*` | Socket.IO 长连接 |

---

## 优雅关闭

`SIGINT` / `SIGTERM` 触发 `shutdown(signal)`：

1. `await gateway.shutdown()` —— Socket.IO 关闭，断开所有 socket
2. `httpServer.close()` —— 停接受新连接，等现有连接结束
3. 在 close 回调里 `sqlite.close()` —— 让 WAL 落盘
4. `process.exit(0)`
5. 5 秒兜底 `process.exit(1)`，防止 socket 拒绝关闭挂死

`shuttingDown` flag 防止重复触发。

---

## 与前端的拼接（dev / prod）

**dev**：

```
浏览器 ← Vite dev (5173) ← React HMR
                ↓ /api/* 和 /socket.io/* 经 vite.config.ts proxy
            Express (3000)
```

Vite 配置（未来加）：

```typescript
// vite.config.ts
server: {
  proxy: {
    "/api": { target: "http://localhost:3000", changeOrigin: true },
    "/socket.io": { target: "ws://localhost:3000", ws: true },
  }
}
```

**prod**（未来加）：

```typescript
// 在 app.ts 后段
if (process.env["NODE_ENV"] === "production") {
  app.use(express.static(path.join(import.meta.dirname, "../../dist/client")));
  app.get("*", (_req, res) => res.sendFile(path.join(distClient, "index.html")));
}
```

同源服务，无 CORS。

---

## 易踩的坑

- **不要**用 `app.listen()` 直接起服务——必须用 `http.createServer(app)` 然后 `httpServer.listen()`，否则 Socket.IO 没法挂上去。
- **不要**在 tRPC 之前 mount catch-all 路由（如 `app.get("*", ...)`）——会拦截 `/api/trpc/*`。
- **不要**在 `createContext()` 里做异步昂贵操作——每次请求都跑，会拖慢延迟。当前实现是同步常量返回，零开销。
- **不要**在 NODE_ENV 没设的情况下混用 dev/prod 行为——总是用 `cross-env` 显式设置。
- **不要**在 shutdown 时不等 gateway / httpServer close 就 `sqlite.close()`——可能正在被某个 in-flight 请求使用。

---

## 验证

```bash
npm run dev
# huko server listening on http://127.0.0.1:3000
# 浏览器开 http://127.0.0.1:3000 看 landing
# curl http://localhost:3000/health
# curl http://localhost:3000/api/trpc/chat.list
```

---

## 见

- [gateway.md](./gateway.md) —— Socket.IO 层
- [routers.md](./routers.md) —— tRPC routers
- [orchestrator.md](./orchestrator.md) —— engine 装配
- [db.md](./db.md) —— migration 与 client
