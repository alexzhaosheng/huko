# Tools 注册系统

> `server/task/tools/` —— 工具的双注册入口与自注册流程。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/task/tools/
  registry.ts          双注册入口 + getTool / getToolsForLLM
  index.ts             barrel + side-effect imports（具体 tool 加进来时再扩）
  server/              （未来）具体 server tools
  workstation/         （未来）具体 workstation tools
```

---

## 双注册入口

```typescript
import { registerServerTool, registerWorkstationTool } from "@/task/tools";

// Server tool —— 进程内执行
registerServerTool({
  name: "add",
  description: "...",
  parameters: { type: "object", properties: { ... }, required: [...] },
}, async (args, ctx) => {
  // 返回 string 或 { result, error?, metadata? }
  return String(args.a + args.b);
});

// Workstation tool —— 通过 Socket.IO 路由到用户本地机器
registerWorkstationTool({
  name: "shell",
  description: "Execute a shell command on the user's machine.",
  parameters: { ... },
});
```

**两个函数互斥**：重复注册同名 tool 抛错。Workstation tool 不带 handler——执行时走 `ctx.executeTool` callback。

---

## 为什么不用单 register + flag

WeavesAI 用 `registerTool(name, def, handler, { workstation: bool })`。**huko 改双入口**：

- 意图明确，函数名就说清楚 tool 在哪里跑
- TS 类型上把 `handler` 与 `workstation` 分开——server tool 必须有 handler，workstation tool 不能有
- 强制工具作者在写文件时就决定 dispatch 路径，不靠注释约定

---

## ServerToolHandler 契约

```typescript
type ServerToolHandler = (
  args: Record<string, unknown>,
  ctx: TaskContext,
) => Promise<string | ServerToolResult> | string | ServerToolResult;

type ServerToolResult = {
  result: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
};
```

- 返回 string —— 默认成功
- 返回 `{result, error}` —— 显式 error 报告
- 抛异常 —— 被 [`executeAndPersist`](./pipeline.md#tool-executets) 捕获转 error result

---

## 自注册流程

每个 tool 文件**顶层**调用 `registerServerTool(...)`：

```typescript
// server/task/tools/server/add.ts
import { registerServerTool } from "../registry.js";

registerServerTool({ name: "add", ... }, (args) => { ... });
```

`tools/index.ts` 集中 side-effect import 所有 tool 文件：

```typescript
// server/task/tools/index.ts
import "./server/add.js";
import "./server/message.js";
import "./workstation/shell.js";
// ...
```

TaskLoop 启动时 `import "./tools/index.js"` 触发全部注册。

**新增 tool**：写一个文件，在 `tools/index.ts` 加一行 import。无其他改动。

---

## getToolsForLLM 与 filterKey 缓存

```typescript
function getToolsForLLM(filter?: ToolFilter): Tool[];
type ToolFilter = (name: string, kind: "server" | "workstation") => boolean;
```

Pipeline 用 filter 隐藏当前不可见的 tool（如 browser 未激活时）。每次调用都重建 array 浪费——pipeline 缓存一个 `filterKey`，filter 不变就复用上次的 array，**保 LLM prompt cache 命中**。

（filterKey 缓存的实际实现在 pipeline 里，等 tool 多起来后落地。）

---

## 易踩的坑

- **不要**在 tool 文件外（比如 router、handler）调用 `registerServerTool`——会让注册时机不可控。
- **不要**重复注册同名 tool——会抛错。测试时用 `_resetRegistryForTests()` 清空。
- **不要**在 server tool handler 里阻塞 event loop（同步 CPU 重活）——所有 task 共用一个 Node 进程。

---

## 见

- [pipeline.md](./pipeline.md) —— `executeAndPersist` 怎么消费 registry
- [llm.md](./llm.md) —— `Tool` / `ToolCall` 类型定义
- [task-loop.md](./task-loop.md) —— TaskLoop 怎么把 result.toolCalls 路由到 executeAndPersist
