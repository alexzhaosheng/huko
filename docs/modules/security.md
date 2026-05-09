# Security: API keys

> `server/security/` —— **DB 不持有 API key**。运行时按层查找 ref → secret。

---

## 心智模型

`infra.db` 的 `providers.api_key_ref` 列存的是**逻辑名**（如 `"openrouter"`），
不是真 key。每次 task 启动，`server/security/keys.ts` 把这个 ref 解析成
真值传给 LLM 客户端。

后果：

- `~/.huko/infra.db` 和 `<cwd>/.huko/huko.db` 都**不含敏感数据**
- 备份、压缩、上传到 S3、`gh` 仓库都**安全**
- 同一个 provider 定义在不同机器 / 不同项目下用**不同**的真 key（看哪一层先命中）

---

## 三层查找（高 → 低）

```
1. <cwd>/.huko/keys.json             { "<ref>": "<value>" }
2. process.env.<REF_UPPER>_API_KEY   shell / 系统级
3. <cwd>/.env                        <REF_UPPER>_API_KEY=<value>
```

第一个非空字符串赢。三层都没 → `resolveApiKey()` throw 一条信息明确的错，
列出**这三个地方**让用户挑一个去填。

### Env-var 命名约定

`<REF.toUpperCase()>_API_KEY`，非 `[A-Z0-9]` 的字符替换成 `_`：

| ref | env name |
|---|---|
| `openrouter` | `OPENROUTER_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `my-corp.gateway` | `MY_CORP_GATEWAY_API_KEY` |

跟 OpenAI / Anthropic / OpenRouter 官方 SDK 的命名习惯一致——你已经有的
shell 配置就能直接被 huko 读到。

`.env` 解析支持的子集：`KEY=value` / `KEY="value"` / `KEY='value'` /
`# comment` / `export KEY=value`。**不**支持变量内插（`$OTHER`）/ 多行 /
转义序列。要复杂的换 `dotenv` 包，资源限制不在解析。

### 没有 `~/.huko/keys.json`

故意不做。**用户级默认 = 你的 shell rc 文件**（`export OPENROUTER_API_KEY=...`
in `~/.zshrc`）。第二层（process.env）就是用户级。

加第四层（`~/.huko/keys.json`）会让用户多一处可能漏掉的地方，且与 shell
rc 重复。等真有人提需求再加。

---

## CLI

### `huko keys set <ref> <value>`

写到 `<cwd>/.huko/keys.json`（合并已有内容），POSIX 上 `chmod 600`。
Windows 上忽略 chmod（fallback：`.gitignore` 默认排除）。

### `huko keys unset <ref>`

从 `<cwd>/.huko/keys.json` 移除一行。

### `huko keys list`

打印**每个** provider 的 `apiKeyRef` + 当前命中的层 + 对应 env-var 名 +
哪些 provider 在用它。**永不**打印 value——保持"不通过 stdout 泄漏 key"。

```
REF          RESOLVES FROM   ENV VAR              USED BY
─────        ─────────────   ──────────────────   ───────────
openrouter   project         OPENROUTER_API_KEY   OpenRouter
anthropic    env             ANTHROPIC_API_KEY    Anthropic Direct
mycorp       unset           MYCORP_API_KEY       Corp Gateway
```

`unset` 行下方会再打印三层规则的提示。

---

## 默认 .gitignore

`<cwd>/.huko/` 第一次被创建（首次 `huko run` / `huko sessions new` /
`huko provider add` ...）时，`SqliteSessionPersistence` 自动写入：

```
huko.db
huko.db-journal
huko.db-wal
huko.db-shm
keys.json
state.json
```

意图：

- DB / 凭证 / cwd-specific 状态默认不入 git
- 项目级 config / roles / 自动生成的 `.gitignore` 本身**可以**入 git——它们
  描述项目的 huko 行为，团队可以共享

要把对话历史也入 git？把 `huko.db` 从 `.huko/.gitignore` 删掉。这是显式
opt-in，不会有"我以为没入结果入了"的事故。

---

## 安全边界

### 这个设计**做**：

- 把"用户身份"（key）和"项目数据"（对话）彻底分离
- 让备份 / 复制 / 上传 DB 文件**安全**
- 让"同 provider 定义不同 key per cwd"成为自然支持
- 与生态命名（`OPENROUTER_API_KEY` 等）对齐
- 让 keys.json 在 POSIX 上 `chmod 600`，团队成员看不见你的 key

### 这个设计**不做**：

- **不**加密 keys.json——单用户 + 600 权限够了；硬要加密就是 OS keychain（macOS Keychain / Windows DPAPI / libsecret），那是另一刀
- **不**做 key rotation——`huko keys set` 直接覆盖；要 audit log 自己外挂
- **不**支持 secret manager 集成（Vault / AWS Secrets Manager）——可以做成"另一种 ref 格式"，但目前没需求
- **不**对 .env 文件做 hardlink / inotify 跟踪——读一次缓存到任务结束

---

## 添加新查找层的协议

如果以后真的需要加一层（比如 `~/.huko/keys.json`、OS keychain、HashiCorp Vault），
按这个步骤：

1. 在 `server/security/keys.ts` 的 `resolveApiKey()` 里**按优先级位置**插入新查找
2. 在同文件的 `describeKeySource()` 里加对应的 `KeySourceLayer` 字面值
3. 更新这份文档的查找表
4. 加 CLI（如果是显式管理的层，例如 keychain-set / keychain-unset）

**不要**只加 `resolveApiKey` 不加 `describeKeySource`——`huko keys list` 会显
示错误的"unset"，反而误导。

---

## 易踩的坑

- **不要**手写 `apiKey: process.env["OPENROUTER_API_KEY"]` 在 demo / 测试代
  码里——用 `apiKeyRef: "openrouter"` 让 `resolveApiKey` 处理，统一行为
- **不要**把 ref 当 key 拼到 URL / 错误信息里——它是公开的引用名，不是密钥
  但养成习惯 ref 不进日志、value 严格内部
- **不要**用 `chmod 600` 假设跨平台一致——Windows 上无效，靠 gitignore + 用户
  目录权限做兜底
- **不要**期望 `<cwd>/.env` 解析等同 `dotenv` 包——是个最小子集，复杂用法换包
- **不要**把 `keys.json` 入 git。即使你删了 `.gitignore`，建议在 git pre-commit
  hook 里 grep 一遍

---

## 见

- [persistence.md](./persistence.md) —— 为什么 DB 不能存 key
- [cli.md](./cli.md) —— `huko keys` / `huko provider` 命令的细节
- [audit-2026-05.md](../audit-2026-05.md) —— 触发这次重构的审计
