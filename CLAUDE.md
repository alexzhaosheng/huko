# CLAUDE.md

工作守则。每次会话开始读一遍。

---

## 一、最高原则：从根本解决，不要打补丁

发现一个 callsite 多做了一步、一个调用方需要"先 X 再 Y"、一个接口需要 duck-type
的 cast、一个组件需要"额外配置才能跑"——**这是设计错位的信号，不是修补的目标**。

正确反应：找到职责真正归属的那个对象，把工作搬过去。**不要**在调用点加 helper /
flag / wrapper / 文档说"记得这么做"来兜住。

### 自检清单（看到下面任何一条都要警觉）

- 多个 callsite 都在 `prep(); thing.doX()` —— prep 应该住进 `thing`
- 接口里出现 `?:` 可选方法 + callsite 用 `xxx?.()` —— 大概率应该是必选
- 接口签名出现 `xxx as unknown as { foo?: ... }` 这种 cast —— 类型在抗议你正在
  绕过它
- 出现"必须先 A 再 B"的隐式排序约束写在注释里 —— A 应该是 B 的 prerequisite，
  写进类型 / constructor / pre-condition assertion
- 一个 flag 加进来是为了"绕开"另一个组件的副作用（如 `--no-init` / `--skip-X`）
  —— 副作用本身的位置错了
- 同一份"setup"代码在 daemon、CLI、test、script 各自重复一遍 —— 抽到被 setup
  对象的 constructor 里
- "我得加文档教用户怎么用" —— 文档教不会的事情，类型和 constructor 应该自己防
  住

### 反例（huko 自己的真实历史）

- ❌ `bootstrap.ts` 调 `runMigrations()` 然后 `new SqlitePersistence()` ——
  bootstrap 不该知道某个 backend 需要 migration
- ✅ `runMigrations()` 移进 `SqlitePersistence` 的 constructor。schema 管理是
  这个 backend 的内部细节
- ❌ `Persistence.close?()` 可选 + 每个 callsite `(p as unknown as {close?:...}).close?.()`
- ✅ 所有 backend 实现 `close()`（Memory 写 no-op），接口去掉 `?`
- ❌ 想加 `--seed-from-env` 来"绕过" SQLite 的存在
- ✅ 真正的清洁解：直接 `new MemoryPersistence()` + 自己种子，不构造 SqlitePersistence
  就不会有 disk artifacts

### 何时确实该打补丁

只有当**根本修法的成本远大于补丁价值**时——比如要改公共 API、要破坏老用户、要改
schema migration、要重构核心数据流。这种情况：

1. 把补丁打在最靠近"责任所属"的地方
2. **写注释解释为什么这是补丁、根本修法应该长什么样**
3. 留个 `TODO(arch)` 或在对应模块文档里记一行

不要假装补丁是合理设计——它是欠下的债，记账。

---

## 二、文件写入约定（Windows 文件系统块缓存问题）

huko 的开发环境是 Windows + WSL Linux sandbox 混合。Edit / Write 工具写到 Windows
路径，但 bash 沙箱透过 WSL mount 读到的是**带 block cache 的旧版本**。会出现：

- Read tool 看到完整的新内容，bash 看到截断旧版本
- tsc（在 bash 里跑）按截断版本报"Unterminated string literal" / `}` expected
- 反复 Edit 同一个文件越改越破

**对策**（按重要性）：

1. **substantial 改动用 bash heredoc 写**：`cat > /sessions/.../path << 'HUKO_EOF' ... HUKO_EOF`。
   bash 写、bash 读，缓存层一致
2. 写完立刻 `wc -l` + `tail -3 | cat -A` 审计：行数对得上、最后一行有 `$`（trailing
   newline）
3. 改完一组文件，跑 `npx tsc --noEmit` 看 bash 视角下文件状态是否健康。出现"Invalid
   character" / 截断诊断 → heredoc 重写
4. **不要**用 Edit 工具做超过 ~3 行的修改——一次大 Edit 经常触发 cache 失同步

---

## 三、TypeScript / 代码风格

继承 architecture.md 里的"代码约定"那段。要点重申：

- ESM + 显式 `.js` 后缀，所有相对 import 写 `from "./xxx.js"`
- `strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess`
- 可选字段**不**塞 `undefined`，用条件展开：`...(x !== undefined ? { x } : {})`
- 单文件单职责，超 ~300 行就该想想能不能拆
- No DOM in kernel
- No god-file，没 commander/yargs（30 行手写够用）

---

## 四、提交前必跑

```bash
npx tsc --noEmit       # 严格类型检查
npm test               # tests/ 下整套 node --test 套件
```

商业常识：类型不过不交、`exit=0` 才算 done。

---

## 五、git 分支约定

- **永远从 `develop` 开新分支**，不从 `main`、不在 `develop` 上直接堆 commit
  （除非是 trivial 的 doc / config 小动作）
- **命名**：
  - 修 bug → `bugfix/<短描述-kebab-case>`，例如 `bugfix/markdown-streaming-render`
  - 加 feature / 重构 / 新能力 → `feature/<短描述-kebab-case>`，例如
    `feature/browser-control`
- 不确定是 bug 还是 feature 时优先选 `bugfix/`（"它本来应该 work 但没有"）
- PR 目标分支是 `develop`，不是 `main`

---

## 六、领域速查（更新时记得同步 architecture.md）

- **kernel 边界**：`server/engine/` + `server/task/` + `server/services/` + `server/core/llm/`
  这些目录**不**直接 import HTTP / Socket.IO / drizzle / better-sqlite3 / DOM
- **Persistence 是两个 seam，不是一个**：
  - `InfraPersistence` 在 `~/.huko/infra.db`（providers / models / 系统默认）
  - `SessionPersistence` 在 `<cwd>/.huko/huko.db`（sessions / tasks / entries）
  - 加新 backend = 实现一个或两个接口
- **DB 永不持有 API key**：`providers.api_key_ref` 是逻辑名；真值由
  `server/security/keys.ts` 三层查找（`<cwd>/.huko/keys.json` > env > `<cwd>/.env`）
  解析。后果：DB 文件可以备份 / 复制 / 入仓而不泄密
- **`<cwd>/.huko/.gitignore` 自动生成**：huko.db / keys.json / state.json 默认
  排除。要把对话入 git？显式删 `huko.db` 那行
- **Frontends（CLI / daemon / 未来 IDE 插件）消费 kernel**：单向依赖，frontend
  → kernel，绝不反向

---

## 七、如果你不确定

宁可问、不要猜。huko 还在早期，宁可挪一刀大重构，也不要堆补丁让架构腐化。
