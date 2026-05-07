# LLM 调用层

> `server/core/llm/` —— 多协议、多 provider 的 LLM 调用抽象。
>
> 见 [架构总览](../architecture.md) 了解跨模块原则。

---

## 文件

```
server/core/llm/
  types.ts                共享类型：Protocol / LLMMessage / Tool / ToolCall / LLMTurnResult / LLMCallOptions / TokenUsage / PartialEvent
  protocol.ts             ProtocolAdapter 接口 + adapter 注册表
  invoke.ts               公共入口；XML 模式前后处理在这一层
  xml-tools.ts            XML 工具调用：inject 到 system prompt / parse <function_calls>
  register.ts             副作用模块，集中注册所有内置 adapter
  adapters/
    openai.ts             OpenAI 协议（含流式 SSE）
  providers/
    openrouter.ts         OpenRouter preset
  index.ts                barrel + 触发 register
```

---

## 调用模型

```typescript
import { invoke, withOpenRouter } from "@/core/llm";

const result = await invoke(withOpenRouter({
  apiKey, model: "anthropic/claude-opus-4-5",
  messages, tools,
  toolCallMode: "native",        // 或 "xml"
  thinkLevel: "high",            // 可选
  signal: controller.signal,     // 可选，中断
  onPartial: (e) => {            // 给了就走流式 SSE
    if (e.type === "content") /* token delta */;
    if (e.type === "thinking") /* reasoning delta */;
  },
}));
// → { content, toolCalls, thinking?, usage }
```

---

## 三个正交的轴

1. **协议（Protocol）**——决定走哪个 adapter。`openai`、`anthropic`、（未来）`google`、...
2. **工具调用编码（ToolCallMode）**——`native`（协议自己的 `tool_calls`）vs `xml`（`<function_calls>` 文本嵌入）。XML 模式跨协议通用。
3. **Provider Preset**——`(协议, baseUrl, 默认 headers)` 的命名组合。**不**参与运行时分发，只是配置便利。

---

## 关键设计

### XML 模式在 invoke 这一层处理

`invoke()` 检测 `toolCallMode === "xml"` 时：

- pre：`injectToolsAsXml(messages, tools)`——工具定义注入 system prompt
- post：`parseXmlToolCalls(text)`——从响应文本抠 `<function_calls>` 块

Adapter **永远只关心**自己协议的 native 调用。换协议 = 写一个 adapter 文件 + `register.ts` 加一行。

### 流式

- `onPartial` 给了就走 SSE，content / thinking 各有 delta 事件
- Tool-call args **不流**（拼到一半的 JSON 字符串没意义），内部累加完整后塞进 `LLMTurnResult.toolCalls`
- 不流的时候 adapter 仍可走非流式端点或者流式但缓冲——对调用方无差别

### Reasoning 双字段兼容

- DeepSeek 风格：`reasoning_content`
- OpenRouter 归一化：`reasoning`
- 两者都识别，统一映射到 `thinking`

Request 那边 `thinkLevel` → `reasoning_effort`。

### Retry 不在这层

Adapter 单次尝试，失败抛 `LLMHttpError`。Retry / 计数 / 日志留给上层 [pipeline](./pipeline.md)。单一职责。

---

## LLMMessage 形态

```typescript
type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];   // assistant native 模式工具调用
  toolCallId?: string;      // tool 角色：响应哪次调用
  thinking?: string;
  _entryId?: number;        // DB 反向引用，仅 compaction 用
};
```

- Native 模式：assistant turn 带 `toolCalls`，后续 tool turn 带 `toolCallId`
- XML 模式：tool calls 直接嵌在 content 文本里，`toolCalls` 字段保持 undefined
- `_entryId` 是私有字段，**adapter 在序列化时必须忽略**——绝不发给 provider

---

## 扩展手册

### 加一个新协议（如 anthropic-native、google-native）

1. 写 `adapters/<name>.ts`，导出 `xxxAdapter: ProtocolAdapter`
2. 在 `register.ts` 加一行 `registerAdapter(xxxAdapter)`
3. 在 `types.ts` 的 `Protocol` 联合类型加上字符串字面量

不需要改其他任何文件。

### 加一个 provider preset（如 deepseek、azure、anthropic-direct）

1. 在 `providers/<name>.ts` 写一个 `ProviderPreset` 对象 + `withXxx()` 工厂
2. 从 `index.ts` 重导出

Provider 是配置便利，**不是**运行时抽象。绕过 preset 直接传 `protocol + baseUrl + apiKey` 调 `invoke()` 完全合法。

---

## 易踩的坑

- **不要**在 LLM messages 里给 provider 发 `_entryId`——这是私有反向引用字段。
- **不要**让 adapter 知道 retry / 计数 / 日志——它只管单次 HTTP 往返。
- **不要**把 ProviderPreset 做成 registry 化的运行时概念——会复杂化 invoke 调用路径。
- **不要**在 adapter 里手动拼 XML 工具——XML 模式由 `invoke()` 在外层包夹处理。

---

## 验证

```bash
OPENROUTER_API_KEY=sk-or-... npx tsx scripts/llm-demo.ts
```

烟测覆盖：流式、native tool、xml tool 三段。

---

## 见

- [pipeline.md](./pipeline.md) — `callLLM` 怎么把 invoke 包装成一次 task 内迭代
- [engine.md](./engine.md) — `LLMMessage.toolCalls` 在 SessionContext 中的存储
