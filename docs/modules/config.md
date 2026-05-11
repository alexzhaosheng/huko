# Config 子系统

> `server/config/` —— 单一配置入口。所有可调参数都从这里读。
>
> 见 [架构总览](../architecture.md)。

---

## 设计目标

**所有 hardcoded 参数集中收口**。操作者改一个 token 阈值 / 超时 / 默认 model
不应该需要改源码。

---

## 文件

```
server/config/
  types.ts        HukoConfig 类型 + DEFAULT_CONFIG（fallback 值）
  loader.ts       loadConfig + getConfig + setConfigForTests
  index.ts        barrel
```

---

## 加载层（低优先 → 高优先）

```
1. DEFAULT_CONFIG                          内置兜底
2. ~/.huko/config.json                     用户全局
3. <cwd>/.huko/config.json                 项目级
4. process.env.HUKO_CONFIG=<path>          env 强制覆盖
5. opts.explicit                           程序内显式（CLI flag / 测试）
```

每层 deep-merge 在前一层之上。缺的字段沿用前层；存在的字段覆盖。
**数组整体替换**，不拼接（match 用户的"我设这个列表" mental model）。

JSON 文件支持 `_comment` / `_commentXxx` 键作为人类可读注释——loader 解析时
自动去掉。

---

## 当前 schema

```typescript
type HukoConfig = {
  task: {
    maxIterations: number;       // 默认 200
    maxToolCalls: number;        // 默认 200
    maxEmptyRetries: number;     // 默认 3
  };
  compaction: {
    thresholdRatio: number;      // 默认 0.7（70% 模型 window 触发）
    targetRatio: number;         // 默认 0.5（压缩到 50%）
    charsPerToken: number;       // 默认 4
  };
  tools: {
    webFetch: {
      maxBytes: number;          // 默认 1 MiB
      timeoutMs: number;         // 默认 20_000
    };
  };
  cli: {
    format: "text" | "jsonl" | "json";  // 默认 "text"
  };
  daemon: {
    port: number;                // 默认 3000
    host: string;                // 默认 "127.0.0.1"
  };
};
```

---

## 用户怎么用

最小例子：把 compaction 阈值调低到 60%，并改 webFetch 超时到 60s：

```jsonc
// ~/.huko/config.json
{
  "_comment": "huko 全局配置",
  "compaction": {
    "thresholdRatio": 0.6
  },
  "tools": {
    "webFetch": {
      "timeoutMs": 60000
    }
  }
}
```

只改这两个字段，其他全部继承默认。

项目级覆盖：在 repo 根放 `.huko/config.json`，加项目专属调整。例如某个项目的
任务都很长，提高 iteration 上限：

```json
{
  "task": { "maxIterations": 500 }
}
```

---

## 加载时机

bootstrap 必须在构造 orchestrator 前调 `loadConfig()`：

```typescript
// CLI
loadConfig({ cwd: process.cwd() });
const persistence = ...;
const orchestrator = new TaskOrchestrator({ persistence, ... });

// daemon
loadConfig({ cwd: process.cwd() });
const cfg = getConfig().daemon;
const PORT = Number(process.env.PORT ?? cfg.port);
```

之后任何 kernel 模块都可以 `import { getConfig } from "../config/index.js"`
直接读，无需再传配置进来。

---

## 不做热重载

配置在进程**启动时读一次**，缓存内存。改 config 文件**不影响**正在跑的进程。
要让新配置生效，重启。

理由：

- huko 是 CLI / daemon 形态，进程生命周期短。重启代价低
- 实现热重载要给所有 `getConfig()` 调用点引入"哪一刻读到的值"语义，复杂
- WeavesAI 自己的 chat-agent.json 也是 read-once。这条路验证过

如果未来 daemon 模式真的需要热重载，加个 `huko config reload` 命令推全局
re-load 即可。设计上没有阻碍。

---

## 检查当前配置

```bash
npm run huko -- config show
```

会打印：

1. **Resolved config**: 最终生效的完整 JSON
2. **Layers**: 每个来源单独列出（default / user / project / env / explicit），
   带文件路径。可以一眼看出"这个值来自哪一层"

debug "为啥我的设置没生效" 必备。

---

## 未来扩展

- `huko config get <path>` —— 读单个值
- `huko config set <path> <value>` —— 写到 ~/.huko/config.json
- `huko config edit` —— 在 $EDITOR 里打开
- `huko config init` —— 生成示例
- env-var override 模式（`HUKO_TASK_MAXITERATIONS=300`）—— 暂时不做，YAGNI

---

## 添加新 tunable 的协议

1. 在 `types.ts` 的 `HukoConfig` 加字段（带 TS 类型 + JSDoc）
2. 在 `DEFAULT_CONFIG` 加默认值
3. 在消费它的模块（task-loop / pipeline / tool / ...）`getConfig().<group>.<field>` 读
4. 不写文档说"操作者应该改 X"——这个 schema 自带文档；JSDoc 解释字段语义即可

**禁止**：不要加"声明了字段但没消费者"的死字段（参考 audit 报告里 WeavesAI
capability 的反面教训）。每加一个 config key 必须配一个 runtime 消费者。

---

## 易踩的坑

- **不要**在测试里直接改 module-global config —— 用 `setConfigForTests(c)` /
  `resetConfigForTests()`。否则测试之间会污染
- **不要**在 module top-level 调 `getConfig()` —— 那时 loadConfig 可能还没跑。
  在函数体内调，运行时读
- **不要**期望 config 改了能立刻生效——目前是 read-once，要重启
- **不要**把敏感数据（API key）写进 config.json —— provider 配置走 SQLite
  `providers` 表，用 `huko --memory` 可以跨用户避免泄漏

---

## 见

- [audit-2026-05.md](../audit-2026-05.md) —— 当初为什么要做 config 子系统
- [cli.md](./cli.md) —— `huko config show` 命令
