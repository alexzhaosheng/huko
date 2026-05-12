# CI/CD 设计 + 执行状态

> 本文是真相之源。修改 workflow 或 release 流程时同步更新这里。

---

## 总体设计（三阶段）

CI/CD 分三个互相独立的 workflow：

| Phase | Workflow | 触发 | 现状 |
|---|---|---|---|
| 1 | **CI**（lint + test 跨平台 + docker sanity） | PR / main push | ✅ **已实现** |
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

## Phase 1: CI（已实现）

### 文件

- `.github/workflows/ci.yml`

### 触发

- 任何 PR
- `push` 到 `main`
- 手动 `workflow_dispatch`

### 两个 job

**`test` (matrix: ubuntu / macos / windows × node 24)**：
1. checkout
2. setup-node + npm cache
3. `npm ci`
4. `npx tsc --noEmit`
5. `npm test`（536 个 test，POSIX-only 的部分自带 `isWin` skip）
6. `npm run build:cli`（验证 esbuild bundle 在每个平台都能成功打出来）

`fail-fast: false` → 三个 OS 的失败都看得见，不会因为 Linux 先挂就把 macOS/Windows 取消掉。

`concurrency: ci-${{ github.ref }} cancel-in-progress: true` → 同一个 PR 连推 commit 会取消老的 run，省时间。

**`docker-build` (Linux-only)**：
1. setup-buildx
2. `docker buildx build` linux/amd64 single-arch（不 push，只 load 到本地）
3. smoke：`docker run --rm huko:ci-sanity --help | head -5`

这一步存在的意义：**在 PR 阶段抓 Dockerfile 回归**，不要等到 merge 进 main 再让 edge-image.yml 失败。Smoke 用 `--help`（首字符 `-`）的 argv 形态——这正是之前 ENTRYPOINT bug 的复现路径，所以这条 smoke 既覆盖现状也防回归。

### 为什么三平台 + docker

- `bash.ts` 有 cmd.exe / bash 两条码路径
- `commands/docker.ts` 用 `docker.exe` vs `docker`
- `commands/run.ts` 的 stdin 处理 / `fstatSync` 在 Windows 上有 quirk
- Dockerfile 错配只能在 docker build/run 时露出来，本地 unit test 抓不住

### 跟 edge-image 的关系

CI 不依赖 edge-image，反过来也一样：
- CI fail 不阻断 edge-image（edge 就是"main 当前快照"，质量责任在 PR review 不在镜像 build）
- edge-image fail 不影响 CI 的 PR 状态

如果哪天希望严格联动（比如 main 必须 CI 绿才让 edge-image 跑），加 GitHub branch protection 或者改 edge-image 的 `on: workflow_run`。**现在不做**——目前两套互相独立够清晰。

### Cost

- public repo GHA 免费
- 一次完整 ci.yml run 约 **5-8 分钟**（macOS runner 最慢；Windows next）
- docker-build job 走 gha cache，重复 build 约 **1-2 分钟**

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
| ci | 无（独立） | PR / push 自动检查；release 前置 |
| edge-image | 无（独立） | 用户测 `huko docker run` |
| release | npm/ghcr secrets 配置 | 用户拉 `:VERSION` 镜像、`npm install -g huko@x.y.z` |

故意不让 edge-image 依赖 ci——CI 失败不该阻塞已合并代码的镜像发布（image 反正是 `:edge`，本来就是 "main 当前快照"，质量责任在 PR review 不在镜像 build）。如果将来想加严格联动，参考 Phase 1 的"跟 edge-image 的关系"小节。

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

### CI test job Windows-only 失败

最常见两类：
1. **better-sqlite3 native compile fail**：node 24 + 该平台没有预编译二进制时，npm ci 会触发 node-gyp build。Windows 上需要 Visual Studio Build Tools；setup-node 默认带的应该够，挂了的话可能要加 `microsoft/setup-msbuild` action。
2. **路径分隔符 / glob 展开**：`npm test` 走 `node --test "tests/*.test.ts"`，node 22+ 自己展开 glob，不依赖 shell；如果挂在路径上，多半是某条 test 直接拼了 `/` 没用 `path.join`。

### CI docker-build job 失败

跟 edge-image 同根同源——两者用的 Dockerfile 同一份。CI 只 build linux/amd64，挂了说明 Dockerfile 在 amd64 也坏；arm64-only 的问题（rare）等 edge-image 跑出来才能看见。
