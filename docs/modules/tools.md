# Tools 注册系统

> `server/task/tools/` —— 工具的双注册入口、富返回值、参数 coerce 与策略元数据。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/task/tools/
  registry.ts          双注册入口 + ToolHandlerResult + coerceArgs + 策略
  index.ts             barrel + side-effect imports
  server/
    message.ts         给用户发消息（v1: info / result）
    web-fetch.ts       HTTP GET 单个 URL
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
  dangerLevel: "safe",
}, async (args, ctx) => {
  // 返回 string / ServerToolResult / ToolHandlerResult
  return String(args.a + args.b);
});

// Workstation tool —— 通过 Socket.IO 路由到用户本地机器
registerWorkstationTool({
  name: "shell",
  description: "Execute a shell command on the user's machine.",
  parameters: { ... },
  dangerLevel: "dangerous",
});
```

**两个函数互斥**：重复注册同名 tool 抛错。Workstation tool 不带
handler——执行时走 `ctx.executeTool` callback。

---

## 为什么不用单 register + flag

WeavesAI 用 `registerTool(def, handler?)` + `def.executionTarget`。**huko 改双入口**：

- 意图明确，函数名说清楚 tool 在哪里跑
- TS 类型上把 `handler` 与 `workstation` 分开——server tool 必须有
  handler，workstation tool 不能有
- 强制工具作者在写文件时就决定 dispatch 路径，不靠 def 字段约定

---

## ToolHandlerResult — 富返回值

server tool handler 可以返回三种东西，按表达力递增：

```typescript
type ServerToolHandler = (
  args: Record<string, unknown>,
  ctx: TaskContext,
) => Promise<string | ServerToolResult | ToolHandlerResult>
   | string
   | ServerToolResult
   | ToolHandlerResult;

// 1. 字符串 —— 最简，直接当作 result content
return "ok";

// 2. ServerToolResult —— 兼容老式 / 简单错误报告
return { result: "...", error: null, metadata: {...} };

// 3. ToolHandlerResult —— 完整语义
type ToolHandlerResult = {
  content: string;                // LLM 看到的 tool result
  metadata?: Record<string, unknown>;
  finalResult?: string;           // 当 set，写入 ctx.finalResult
  shouldBreak?: boolean;          // 当 true，TaskLoop 干净结束（status=done）
  summary?: string;               // 给 UI 的短摘要
  attachments?: ToolAttachment[]; // 工具产生的文件
  error?: string | null;          // 非 null 就是 error result
};
```

**`shouldBreak` 语义**：当前 tool 持久化完成后，TaskLoop 直接退出循环，
状态解析为 `done`。**不会再调一次 LLM**，剩余的 `deferredCalls` 会被丢弃。
`message`（mode=result）就是靠这个机制结束任务。

**`finalResult` 语义**：写入 `ctx.finalResult` + `ctx.hasExplicitResult=true`。
后续 task summary 里能拿到。和 `shouldBreak` 通常配合使用，但分开保留——
未来 `agent` 类的子任务可能只想填 `finalResult` 不退出主循环。

---

## coerceArgs —— 运行时参数矫正

LLM 偶尔会把 boolean 写成 `"true"`、把数组写成 JSON 字符串、把数字写成
`"5"`。`tool-execute.ts` 在分发前调用 `coerceArgs(name, args)`，按
declared schema 做 best-effort 转换：

| schema type | 接受的输入                                | 转换为     |
|-------------|-------------------------------------------|------------|
| boolean     | `true`/`false`、`"true"/"false"/"1"/"0"/"yes"/"no"`、数字 | boolean |
| number      | 数字、可解析的字符串                      | number    |
| string      | 任何（数字 / boolean toString）           | string    |
| array       | 数组、`"[...]"` JSON 字符串               | array (递归) |
| object      | object、`"{...}"` JSON 字符串             | object (递归) |

未声明的字段透传不动。缺失的 required 字段不会被自动注入——tool 自己仍可以
显式抱怨。

---

## ToolDisplayTemplate —— UI 紧凑渲染

工具可以可选声明一个紧凑模板，UI / CLI 在工具调用列表里就能渲染成
单行 tag：

```typescript
display: {
  compactTemplate: '<message type="{msgType}">{textShort}</message>',
  extractParams: (args) => ({
    msgType: String(args.type ?? "info"),
    textShort: String(args.text ?? "").slice(0, 80),
  }),
}
```

`extractParams` 是纯函数，返回 `Record<string, string>`。模板里的
`{key}` 直接做字符串替换。没声明 `display` 的 tool 默认就用 tool name 显示。

---

## platformNotes —— 跨平台条件提示

server tool 可以根据 `process.platform` 在 description 末尾追加针对性
说明。typical 例子是 shell tool 在 Windows 上要切到 cmd 语法：

```typescript
registerServerTool({
  name: "shell",
  description: "Execute commands ...",
  platformNotes: {
    win32: "<platform_notes platform=\"windows\">...</platform_notes>",
  },
  ...
}, ...);
```

`getToolsForLLM` 在 materialise 阶段把当前平台的 note 拼到 description 后面，
LLM 就只看到合并后的版本。其他平台的 note 不暴露。

---

## ToolPolicyMeta —— danger level

`registerServerTool` / `registerWorkstationTool` 接受 `dangerLevel: "safe" |
"moderate" | "dangerous"`。registry 自动把它存进 policy registry：

```typescript
import { getToolPolicy } from "@/task/tools";
getToolPolicy("shell"); // { dangerLevel: "dangerous" }
```

目前 huko 还没把 dangerous 接到 approval 流程上——这个 metadata 是
**预留**给未来的 `requestApproval` callback 用。

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
import "./server/message.js";
import "./server/web-fetch.js";
// import "./workstation/shell.js"; // 未来
```

TaskLoop 启动时 `import "./tools/index.js"` 触发全部注册。

**新增 tool**：写一个文件，在 `tools/index.ts` 加一行 import。无其他改动。

---

## getToolsForLLM 与 filterKey 缓存

```typescript
function getToolsForLLM(filter?: ToolFilter | ToolFilterContext): Tool[];

type ToolFilter = (name: string, kind: "server" | "workstation") => boolean;

type ToolFilterContext = {
  deniedTools?: string[];
  browserActive?: boolean;
  workflowActive?: boolean;
  predicate?: ToolFilter;
};
```

Pipeline 用 filter 隐藏当前不可见的 tool（如 browser 未激活时）。每次
调用都重建 array 浪费——pipeline 缓存一个 `filterKey`，filter 不变就复用
上次的 array，**保 LLM prompt cache 命中**。

（filterKey 缓存的实际实现在 pipeline 里，等 tool 多起来后落地。
`browserActive` / `workflowActive` 字段也是预留——目前没有实现这些维度，
但接口位置已经留好。）

---

## 内置 server tools

### `message`

唯一的对用户发声通道。v1 支持两种模式：

- `info` —— 进度/确认，不打断 task
- `result` —— 终结 task，把 text 写入 `finalResult`，触发 `shouldBreak`

`ask` 模式（阻塞等用户回复）依赖 engine 的 `waitForReply` 管道，未上线，先不暴露。
attachments 也先不开，等 fs tools 进来后再恢复。

### `web_fetch`

HTTP GET 单个 URL，参数 `{ url, mode?: "text" | "html" }`。

- `text` 模式：剥 `<script>` / `<style>` / 标签，decode 常见 entity，压空白
- `html` 模式：原样返回
- 1 MiB 上限，20 秒超时
- 仅 GET；不支持其他动词

刻意写得很小——它的另一份职责是**端到端验证 v2 注册管道**。

---

## 易踩的坑

- **不要**在 tool 文件外（比如 router、handler）调用 `registerServerTool`——
  会让注册时机不可控。
- **不要**重复注册同名 tool——会抛错。测试时用 `_resetRegistryForTests()` 清空。
- **不要**在 server tool handler 里阻塞 event loop（同步 CPU 重活）——
  所有 task 共用一个 Node 进程。
- **不要**在 handler 里直接调 `sessionContext.append`——`tool-execute` 会
  替你写 `tool_result` 行。重复写会让 LLM 看到两份。

---

## 见

- [pipeline.md](./pipeline.md) —— `executeAndPersist` 怎么消费 registry / `ToolHandlerResult`
- [llm.md](./llm.md) —— `Tool` / `ToolCall` 类型定义
- [task-loop.md](./task-loop.md) —— TaskLoop 怎么把 result.toolCalls 路由到 executeAndPersist，
  以及 `shouldBreak` 怎么影响循环退出
