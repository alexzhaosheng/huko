# CI/CD 设计 + 执行状态

> 本文是真相之源。修改 workflow 或 release 流程时同步更新这里。

---

## 总体设计（三阶段）

CI/CD 分三个互相独立的 workflow：

| Phase | Workflow | 触发 | 现状 |
|---|---|---|---|
| 1 | **CI**（lint + test 跨平台） | PR / main push | ⏳ 未实现 |
| 2 | **edge-image**（docker `:edge`） | main push | ✅ **已实现**（commit d69888c+） |
| 3 | **release**（npm + docker `:VERSION` + `:latest`） | tag push | ⏳ 未实现 |

我们按 **2 → 1 → 3** 顺序推：先解决"作者要测 docker 路径但本地 build 麻烦"的痛点，再上跨平台保险丝，最后才搞正式发布流程。

---

## Phase 2: `edge-image`（已实现）

### 文件

- `.github/workflows/edge-image.yml`
- `docker/Dockerfile`（多阶段，从源码 build，无需 npm publish 前置）

### 触发

- `push` 到 `main`，且改动涉及 source / Dockerfile / 本 workflow（doc-only PR 不重 build）
- 手动 `workflow_dispatch`（fix workflow 自身后用）

### 行为

1. checkout
2. setup-qemu（让 x86 runner 跑 arm64 emulation）
3. setup-buildx
4. docker login ghcr.io（用 `secrets.GITHUB_TOKEN`，无需另配）
5. build & push 到 `ghcr.io/alexzhaosheng/huko:edge`（外加一个 SHA-pinned 副本 `:edge-${SHA}` 用于精确测试）
6. multi-arch：`linux/amd64` + `linux/arm64`
7. 最后跑 smoke test：`docker run :edge-${SHA} huko --help | head -5`，挂掉就 fail
8. concurrency `cancel-in-progress`：新 push 取消还在跑的旧 run

### 怎么用

```bash
docker pull ghcr.io/alexzhaosheng/huko:edge

# 默认就指向 :edge（commands/docker.ts 的 DEFAULT_IMAGE 在 bridge 期）
huko docker run -- "your prompt"

# 想 pin 一个特定 commit 的 image:
huko docker run --image ghcr.io/alexzhaosheng/huko:edge-<sha> -- "..."
```

### 一次性手动配置（首次 run 之后）

GHCR 包默认是 **private**。第一次 push 之后去：

> github.com/alexzhaosheng?tab=packages → huko → Package settings → Change package visibility → **Public**

之后就匿名 pull，不需要 docker login。

### 已知 cost

- 每次 main push 跑约 **8-15 分钟**（arm64 emulation 拖时间）
- `paths:` 过滤掉 doc-only 改动，docs/* 不会触发
- gha cache 加速重复 build（从 ~12min 降到 ~5min for 增量）

### Bridge: 默认 image 为什么是 `:edge` 不是 `:latest`

`commands/docker.ts:DEFAULT_IMAGE = "ghcr.io/alexzhaosheng/huko:edge"` —— `:latest` 还不存在（要等 Phase 3 release pipeline 上线 + 第一个 tag）。如果默认是 `:latest`，每个 `huko docker run` 都会 404。

> **TODO（Phase 3 落地后）**：把 `DEFAULT_IMAGE` 改回 `:latest`，`:edge` 退化为"main branch 滚动"的二级 channel。同步更新 `tests/docker-parse.test.ts` 里的 `DEFAULT` 常量和 `docs/docker.md` 的 image 选择小节。

---

## Phase 1: CI（未实现）

### 计划

`.github/workflows/ci.yml`：

```yaml
on: [pull_request, push]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: npm run build:cli
```

### 为什么三平台

- `bash.ts` 有 cmd.exe / bash 两条码路径
- `commands/docker.ts` 用 `docker.exe` vs `docker`
- `commands/run.ts` 的 stdin 处理 / `fstatSync` 在 Windows 上有 quirk
- 当前 5xx 个 test 大部分 POSIX-only（`isWin` skip），但 parser / 路径解析等纯逻辑在 Windows 也得过

### Cost

- public repo GHA 免费
- macOS runner 慢但 OK；Windows runner 也行
- 一次完整 matrix run 约 5-8 分钟

---

## Phase 3: release（未实现）

### 计划

`.github/workflows/release.yml`：

- **触发**：push tag 形如 `v*.*.*`
- **两个并发 job**：
  - **npm publish**：跑 `prepublishOnly`（已经有 check + build），`npm publish` 用 `secrets.NPM_TOKEN`
  - **docker publish**：build + push 多架构，tags = `:0.2.0` + `:0.2` + `:latest`，build-arg HUKO_VERSION 同步

### Bridge 期前置

第一次发 v0.1.0 之前要做的事：
1. `npm login` + `npm whoami` 确认账号
2. 仓库 secrets 加 `NPM_TOKEN`（npm 上 generate automation token）
3. 把 `commands/docker.ts:DEFAULT_IMAGE` 改回 `:latest`（见 Phase 2 的 TODO）
4. CHANGELOG 写 0.1.0 内容（人工，或上 release-please）

---

## 本地验证 docker 流程（不依赖 CI）

build:
```bash
cd huko
docker buildx build --platform linux/amd64 -f docker/Dockerfile -t huko-local:dev .
```

跑一次 huko：
```bash
HUKO_DOCKER_IMAGE=huko-local:dev huko docker run -- "say hi in 3 words"
```

清理：
```bash
docker rmi huko-local:dev
```

---

## Workflow 之间的依赖

| Workflow | 依赖谁 | 谁依赖它 |
|---|---|---|
| edge-image | 无（独立） | 用户测 `huko docker run` |
| ci | 无（独立） | release 前手动检查（暂时） |
| release | npm/ghcr secrets 配置 | 用户拉 `:VERSION` 镜像、`npm install -g huko@x.y.z` |

故意不让 edge-image 依赖 ci——CI 失败不该阻塞已合并代码的镜像发布（image 反正是 `:edge`，本来就是 "main 当前快照"，质量责任在 PR review 不在镜像 build）。

---

## 故障排查 cheatsheet

### `edge-image` 失败

1. **build 阶段 OOM**：`node:24-alpine` + better-sqlite3 + arm64 QEMU 比较挤。如果挂，先在 amd64-only 试一遍隔离。
2. **GHCR push 403**：去 repo Settings → Actions → General → Workflow permissions → 选 "Read and write permissions"。
3. **smoke test fail**：本地 `docker run --platform linux/amd64 ghcr.io/alexzhaosheng/huko:edge-<sha> huko --help` 重现，看 stderr。
4. **package visibility 还是 private**：第一次 push 之后必须手动改成 public（一次性，见上）。

### 用户拉不到 image

```bash
docker pull ghcr.io/alexzhaosheng/huko:edge
# Error response: manifest unknown
```
意味着 image 还没 push 过——查 actions tab 看 edge-image workflow 是否绿。

### `huko docker run` 报 docker 不在 PATH

工具的契约：exit 4 + 提示装 docker。这是预期行为，不是 bug。
