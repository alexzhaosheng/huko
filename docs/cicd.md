# CI/CD 设计 + 执行状态

> 本文是真相之源。修改 workflow 或 release 流程时同步更新这里。

---

## 总体设计（三阶段）

CI/CD 分三个互相独立的 workflow：

| Phase | Workflow | 触发 | 现状 |
|---|---|---|---|
| 1 | **CI**（lint + test 跨平台 + docker sanity） | PR / main push | ✅ **已实现** |
| 2 | **edge-image**（docker `:edge`） | main push | ✅ **已实现**（commit d69888c+） |
| 3 | **release**（npm + docker `:VERSION` + `:latest`） | tag push | ✅ **workflow 已实现，未实战** |

我们按 **2 → 1 → 3** 顺序推：先解决"作者要测 docker 路径但本地 build 麻烦"的痛点，再上跨平台保险丝，最后才搞正式发布流程。Phase 3 的 workflow 已经写好，但**第一次 release 还没切**——切之前要走一遍下面的 [first-release checklist](#第一次-release-前置-checklist)。

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

### `:latest` 是默认（v0.1.0 之后）

`commands/docker.ts:DEFAULT_IMAGE = "ghcr.io/alexzhaosheng/huko:latest"`，由 release.yml 在每次 stable tag push 时更新。`:edge` 是 main 滚动的二级 channel，给想试未发版代码的人用。

> 历史：v0.1.0 之前默认是 `:edge`（bridge 期）。在切第一个 tag 那次 commit 里同步切回 `:latest`。

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

## Phase 3: release（workflow 已实现，未实战）

### 文件

- `.github/workflows/release.yml`

### 触发

- push tag 形如 `v*.*.*`（推荐路径）
- `workflow_dispatch` + 手动选 tag（重发 / 修复用）

### 四个 job

**`preflight`**：assert tag 跟 `package.json` 的 `version` 字段匹配。catch "tag 错 commit" 或者"忘了 bump version"，0 修复成本。同时 derive `is_prerelease`（tag 含 `-` → prerelease）。

**`npm-publish`** (gated on preflight)：
- `actions/setup-node` with `registry-url=https://registry.npmjs.org`
- `npm ci`
- `npm publish --provenance --access public`（`prepublishOnly` 在 package.json 里已经跑 check + build:cli，不用单独再跑）
- `--access public` 是 scoped 包发 public 的硬要求
- `--provenance` 加 SLSA build 见证（npm UI 的 Provenance tab 能看），**要求 GitHub repo public**——repo 私有时 npm reject E422
- 用 `secrets.NPM_TOKEN`

**`docker-publish`** (gated on preflight)：
- multi-arch（linux/amd64 + linux/arm64），`--build-arg HUKO_VERSION=<derived>`
- tag 集合（`docker/metadata-action`）：
  - `:VERSION` —— 永远
  - `:MAJOR.MINOR` —— 仅 stable
  - `:latest` —— 仅 stable（prerelease 不动 `:latest`）
- 跑 smoke `docker run :VERSION --help`

**`github-release`** (needs npm + docker)：
- `softprops/action-gh-release` 自动生成 release notes
- 标题、tag 名、prerelease 标记按 derived 信息走
- body 里贴 npm install + docker pull 命令

### 并发 / 故障容忍

- `concurrency: release, cancel-in-progress: false` —— 一次只一个 release，**绝不取消进行中的 release**（半发布的 npm + 没 push 完的 docker 比 fail-loudly 难收拾）
- npm 和 docker 是并发的：一个挂了另一个仍发完。失败的那个走 `workflow_dispatch` 手动重跑就行，不用回滚另一个

### CI 不是硬 gate

故意不做 `on: workflow_run` 联动——**约定**是从 main 上的绿 commit 切 tag。如果切了 red commit，release 仍跑（preflight 只查 version，不查 CI 状态）。要严格联动加 branch protection 或改 trigger，目前不必要。

---

## 第一次 release 前置 checklist

按顺序，做完才能 `git tag v0.1.0 && git push --tags`：

### 1. NPM 准备
- [ ] `npm login` + `npm whoami` 确认是想发的账号
- [ ] 检查 `huko` 这个 package 名在 npmjs.com 上是否可用：
  ```bash
  npm view huko 2>&1 | head -1
  # E404 → 可用；其他 → 已被占；考虑改成 `@alexzhaosheng/huko`
  ```
  改 scoped name 的话同步改 `package.json:name` + workflow 的 `--access public` 仍适用
- [ ] npm 上 generate automation token（Settings → Access Tokens → Generate New Token → Automation type）
- [ ] 仓库 Settings → Secrets and variables → Actions → New repository secret → `NPM_TOKEN` = 上面的 token

### 2. 代码切换 bridge
- [x] `server/cli/commands/docker.ts:DEFAULT_IMAGE` 从 `:edge` 改回 `:latest`
- [x] `tests/docker-parse.test.ts` 里的 `DEFAULT` 常量同步
- [x] `docs/docker.md` 里 "默认镜像" 行同步
- [x] `docs/cicd.md`（本文）这条 checklist 划掉
- [x] 提交 commit message 类似 `chore: switch DEFAULT_IMAGE to :latest ahead of v0.1.0 release`

### 3. Version + CHANGELOG
- [ ] `npm version 0.1.0 --no-git-tag-version` （只改 package.json，不自动打 tag——我们手动控制）
- [ ] （可选）写 CHANGELOG.md，或依赖 GitHub Release 自动生成的 notes
- [ ] 提交 commit 像 `chore(release): v0.1.0`

### 4. 切 tag + push
```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0       # 这一步触发 release.yml
```

### 5. 验证（release.yml 跑完后）
- [ ] `npm install -g @alexzhaosheng/huko@0.1.0` 装得到
- [ ] `docker pull ghcr.io/alexzhaosheng/huko:0.1.0` 拉得到
- [ ] `docker pull ghcr.io/alexzhaosheng/huko:latest` 也能拉到（同一 image digest）
- [ ] GitHub Releases 页面有 v0.1.0 条目
- [ ] `huko docker run -- "hi"` 用 `:latest` 默认值跑通

### 6. 出错怎么办
- npm publish 失败、docker 成功：fix npm 问题（401 → token；403 → name；…），workflow_dispatch 重跑只 npm 那步可以
- docker 失败、npm 成功：同理，重跑只 docker 那步
- preflight 失败：tag 跟 package.json 不匹配，先查 `git checkout v0.1.0 -- package.json`，删 tag (`git tag -d v0.1.0; git push --delete origin v0.1.0`)、修 version、重新 tag

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
| release | npm/ghcr secrets 配置 | 用户拉 `:VERSION` 镜像、`npm install -g @alexzhaosheng/huko@x.y.z` |

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

### release.yml 里 npm publish 401 / 403

- **401**：`NPM_TOKEN` 没设 / 过期 / 类型不对。要 "Automation" 类型的 token，不是 "Publish"（虽然两者都能用，但 Automation 不需要 2FA 交互）。
- **403** with `You do not have permission`：package 名被别人占了或 npm 锁着。改 `package.json:name` 成 scoped（`@<your-handle>/huko`）；workflow 里 `--access public` 已经存在，scoped 公开包必须的。

> **历史**：v0.1.0 第一次试发时 `huko` 这个 unscoped name 被 npm 锁住（2018 年 unpublished 后命名空间没释放）。决定走 scoped `@alexzhaosheng/huko`——立刻能发，永远不冲突。Bin 名仍然是 `huko`（package.json 的 `bin` field 单独定义），用户 install 后输 `huko --help` 不变。

### release.yml 里 npm publish E422 "Unsupported GitHub Actions source repository visibility: private"

`--provenance` flag 要求 GitHub repo 是 **public**（npm 校验 sigstore bundle 时拒绝 private repo）。两条路：
- 把 repo 公开（推荐——保留 provenance）
- 去掉 `--provenance` + 删 workflow 的 `id-token: write` permission（牺牲 SLSA 见证）

v0.1.0 发版时选了第一条；workflow 假定 repo public。如果未来又把 repo 设回 private，记得同步删掉 `--provenance`。

### release.yml 里 preflight 失败 (`tag X expects version Y but found Z`)

tag 和 package.json 不一致。最常见：忘了 bump `package.json:version` 就 tag 了。修法：删 tag、bump、重 tag。**不要**改 package.json 不删 tag，下次 push 还是同一个 tag commit，preflight 还会挂。
