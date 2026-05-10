# Roles

> `server/roles/` + `server/services/build-system-prompt.ts` —— huko 的"角色 / persona"机制。
>
> 见 [架构总览](../architecture.md)。

---

## 概念

**Role** = 一份决定 LLM 工作风格 + 行为规则 + 工具偏好的整体配置单元。每个 task
启动时显式选一个 role（默认 `coding`）。

设计哲学（来自 [agent-design-notes.md](../agent-design-notes.md) 的 WeavesAI 教训）：

- ❌ **不分** identity / language / capabilities 多个独立字段——容易出现"有了名字
  但没有行为"的死代码（WeavesAI capability 那种）
- ✅ **一份 markdown body** 是 role 的全部内容，不拆字段
- ❌ **一个 task 一个 role**，不叠加
- ❌ **role 不进 DB**，文件就够，DB 是 over-engineer

---

## 文件位置（按优先级）

```
1. <project>/.huko/roles/<name>.md       项目级覆盖（最高优先）
2. ~/.huko/roles/<name>.md                用户级覆盖
3. <huko repo>/server/roles/<name>.md     内置（git-tracked）
```

第一个找到就停。**不**做继承 / merge——简单、可预测。

`loadRole(name, cwd)` 是唯一入口，见 `server/roles/index.ts`。

---

## 内置 role

### `coding`（默认）

`server/roles/coding.md`。强调：

- **Read-before-write**：改代码前先看完
- **Run-before-done**：跑测试再说完成
- **Follow conventions**：模仿现有风格，不强加自己的
- **Terse style**：代码是交付物，闲聊是开销
- **Surface uncertainty**：不确定就一句话问
- **Escalation**：删文件 / 改 git 历史 / 大范围网络访问要先 ask

后期会加 `chat` / `review` / `debug` / `writing` / `research` 等 role。

---

## System prompt 构建

`server/services/build-system-prompt.ts` 的 `buildSystemPrompt({ role, cwd })`：

```
[1] role.body                              ← markdown 主体
    ---
[2] # Project context (from CLAUDE.md)
    <project>/CLAUDE.md 内容（如果存在）
    ---
[3] # Environment
    cwd / date / platform
```

`---` 分隔，三段拼成最终 system prompt。Tool 描述**不**进这里——它们由 LLM 调用
管道（XML 模式塞 description block；native 模式走 API 字段）单独处理。

每次 task 启动**重新构建**——`CLAUDE.md` 改了下次跑就生效，无重启。

---

## CLAUDE.md 项目级注入

仿 Claude Code / Cursor 的约定：项目根有 `CLAUDE.md` 就自动包进 system prompt
里。零摩擦上手——已经在用 Claude Code 的项目直接就能给 huko 用。

不需要 `--include-claude-md` flag——存在即包。**不存在**就略过那一段。

---

## CLI 用法

```bash
huko run -- fix the test                          # 默认 role=general
huko run --role=coding -- fix the test            # 显式切到 coding role
huko run --role=writing -- draft a blog post      # 切到 writing role
```

`--role=<name>` 找不到 role 时直接报错退出（exit 1），不 fallback——避免静默用错
role 影响行为。

---

## Frontmatter

可选的 YAML frontmatter 写在文件最前面、被 `---` fence 包起来。**所有字段都可
省略**——空文件也是合法 role。

```yaml
---
description: Coding-focused agent for reading, editing, and reasoning about source code.
model: claude-sonnet-4              # logical id（暂未生效，见下文 TODO）
tools:
  allow: [message, web_fetch]       # 白名单：只有这些工具可见
  deny:  [browser_open]             # 黑名单：永远屏蔽
---

You are huko, a ...
```

### 已接通字段

| 字段 | 类型 | 消费者 | 说明 |
|---|---|---|---|
| `description` | string | （未来 `huko roles list`）| 人读摘要 |
| `tools.allow` | string[] | `getToolsForLLM` | 白名单——省略=所有工具可见 |
| `tools.deny`  | string[] | `getToolsForLLM` | 黑名单——总是赢过 allow |

### 暂未接通

- `model: "<logical id>"` —— 等 `persistence.models.findByLogicalId(string)`
  方法落地后，orchestrator 才能把字符串解析成数字 `models.id`。当前**静默忽略**

### 解析器

- `server/roles/yaml-frontmatter.ts` —— 自带的 ~120 行 YAML 子集解析。
  支持：标量 / 引号字符串 / inline array `[a, b, c]` / 两层嵌套
- **不**支持：block-style 列表（`- item`）、3 层以上嵌套、anchors / aliases、
  多行字符串。要更复杂直接换 `js-yaml` + 删这个文件

### 多层 filter 组合（未来）

将来会加 per-user / per-task 的工具开关。设计上这些都通过同一个
`ToolFilterContext` 合流：

- `allowedTools`：多层**取交集**——每层都收紧
- `deniedTools`：多层**取并集**——任一层禁就禁
- `predicate`：多层**取 AND**

合流逻辑在 orchestrator 调 `getToolsForLLM` **之前**做，registry 本身保持无状态。

---

## 添加新 role

1. 写 `server/roles/<name>.md`（内置）或 `~/.huko/roles/<name>.md`（用户级）
2. （可选）加 frontmatter——只填**有 runtime 消费者**的字段
3. 不动代码，不改 schema

---

## 扩展点（未来，**只在有真实需求时加**）

- `extends: "<base>"` —— role 继承（v3 可能）
- skill catalog 注入（看 [agent-design-notes.md §5.A](../agent-design-notes.md)
  的 WeavesAI skill 机制）

每加一项必须**同时**有：(1) 接口/类型定义、(2) 真实 runtime 消费者、(3) 文档说明
为什么这字段比"直接写进 markdown body"更好。否则就是死代码。

---

## 不做的事

- ❌ **自动场景检测**（看到 `package.json` 自动选 coding role）。魔法到时候解释
  成本远高于让用户加 4 个字符 `--role=`
- ❌ **多 role 叠加**。要混合就写第三个 role 文件
- ❌ **DB 存 role**。文件版本控制就够
- ❌ **i18n 分文件**。语言要求直接写进 role.md body

---

## 见

- [agent-design-notes.md](../agent-design-notes.md) §5（skill / agent / scenario 设计 — WeavesAI 对比）
- [orchestrator.md](./orchestrator.md) —— `sendUserMessage` 怎么消费 `role` 字段
- [cli.md](./cli.md) —— CLI `--role=` flag 怎么解析
