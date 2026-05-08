# Gateway

> `server/gateway.ts` —— Socket.IO 网关层。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/gateway.ts        Socket.IO server + EmitterFactory + room 订阅
```

---

## 职责

- 接 WebSocket 连接，让客户端订阅 session room（如 `chat:42`）
- 给 orchestrator 提供 `EmitterFactory: (room) => Emitter`
- 仅做**推**：server → client。用户操作（sendMessage / stop）走 tRPC

```typescript
const gateway = createGateway(httpServer);
// gateway.io                 — Socket.IO server 实例
// gateway.emitterFactory     — (room) => ({ emit })
// gateway.shutdown()         — 优雅关闭
```

---

## Room 订阅协议

客户端：

```typescript
const socket = io();                       // 连上 server
socket.emit("subscribe", "chat:42");       // 加入会话 room
socket.on("task:entry", payload => { … }); // 接收事件

socket.emit("unsubscribe", "chat:42");     // 离开 room
```

服务端只接受形如 `chat:<digits>` 或 `agent:<digits>` 的 room 名，正则 `^(chat|agent):\d{1,10}$`。其他字符串静默忽略——单用户 + 内网，但保持最小信任面。

---

## 多客户端协同（免费拿）

由于事件 emit 到 **room** 而不是单个 socket，**同一 session 在两个浏览器 tab 打开**自动同步：两个 tab 都 `subscribe("chat:42")`，orchestrator emit 一次，两边都收到。无需任何额外代码。

---

## EmitterFactory 契约

```typescript
type EmitterFactory = (room: string) => Emitter;
type Emitter = { emit: (event: string, data: unknown) => void };
```

实现：

```typescript
const emitterFactory: EmitterFactory = (room) => ({
  emit: (event, data) => { io.to(room).emit(event, data); },
});
```

orchestrator 在 `getOrCreateSessionContext` 时调一次，把得到的 emitter 缓存进 `liveSessionEmitters`。后续 task 事件都通过它推。

---

## 事件清单（server → client）

| 事件名 | Payload 类型 | 何时发 |
|---|---|---|
| `task:entry` | `TaskEntryPayload` | 每条新 entry（user message、ai message draft、tool result、status notice） |
| `task:entry_update` | `TaskEntryUpdatePayload` | 流式 content / metadata patch |
| `task:done` | `{ taskId, summary }` | task 正常完成 |
| `task:stopped` | `{ taskId, summary }` | task 被 stop |
| `task:failed` | `{ taskId, summary }` | task 因预算 / empty turn 等 failed |
| `task:error` | `{ taskId, error: string }` | task 抛异常崩溃 |

定义在 `shared/types.ts`，前后端共享。

---

## 易踩的坑

- **不要**让 gateway 直接调 orchestrator 的状态——所有用户操作走 tRPC。gateway 只是推送层。
- **不要**用单个 socket 的 `socket.emit(...)` 推业务事件——总是用 room (`io.to(room).emit`)，否则多 tab 协同失效。
- **不要**接受任意 room 名订阅——加正则白名单，避免被订阅 `*` 之类。

---

## CORS

dev 时 Vite 跑在另一个端口（5173），Socket.IO 配 `cors: { origin: true, credentials: true }` 允许跨源。prod 时同源服务，CORS 头无害。

单用户系统不带 cookie/auth，CORS 宽松没风险。

---

## 验证

```bash
npm run dev
# server: http://127.0.0.1:3000
# 浏览器 console:
const s = io("http://localhost:3000");
s.on("connect", () => { s.emit("subscribe", "chat:1"); });
# 然后通过 tRPC 发消息，应该看到 task:entry 事件
```

---

## 见

- [orchestrator.md](./orchestrator.md) —— EmitterFactory 的消费方
- [app.md](./app.md) —— gateway 的实例化在 app.ts
- [routers.md](./routers.md) —— 用户操作的入口（tRPC）
