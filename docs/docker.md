# `huko` 在 Docker 里跑

> `server/cli/commands/docker.ts` + `docker/Dockerfile`

## 一句话

```bash
huko docker run -- "fix the bug in main.ts"
```

完全等价于：

```bash
docker run --rm -i \
  -v "$PWD:/work" \
  -v "$HOME/.huko:/root/.huko" \
  --workdir /work \
  ghcr.io/alexzhaosheng/huko:edge \
  -- "fix the bug in main.ts"
```

**镜像 ENTRYPOINT 契约**：image 的 `ENTRYPOINT` 是 `["huko"]`，所以 docker 的位置参数直接当作 huko 的 argv。`docker run … <image> sessions list` 跑 `huko sessions list`；`docker run … <image> -- "prompt"` 跑 `huko -- "prompt"`。这跟在 host 直接敲 `huko ...` 完全一致。

`huko docker run` 这个 wrapper 的全部职责就是**把那串 `-v ... -v ... --workdir ...` 模板免去**，其它语义跟主 huko 一模一样：相同的 flags、相同的 `--` sentinel、相同的 pipe-friendly stdin。

---

## 它做什么 / 不做什么

**它做的**：

1. **三个固定 mount**（不可关闭——这就是约定）：
   | Host | Container | 用途 |
   |---|---|---|
   | `$PWD` | `/work` | 项目目录（含 `.huko/huko.db`、`.huko/keys.json`、源码…）|
   | `$HOME/.huko` | `/root/.huko` | 全局 infra 配置（`providers.json`、`keys.json`、`config.json`）|
   | —— | `--workdir /work` | inner huko 的 cwd 跟 host 用户的 cwd 对齐 |

2. **stdin / stdout 透传**：检测 `process.stdin.isTTY`，是 TTY 就 `-it`，否则 `-i`。这意味着 `cat data | huko docker run -- "..."` 和 `huko docker run --chat` 都自然 work。

3. **`--image <name>` flag**（也认 `HUKO_DOCKER_IMAGE` 环境变量），覆盖默认镜像。

4. **退出码透传**：docker 退什么码 huko 就退什么；docker 被信号杀掉时 huko 重新 raise 信号，让 shell 的 `$?` 得到 128+signo 这种 unix 标准编码。

**它不做的（v1 边界）**：

- **不自动 build / pull image**——让 docker 自己处理 image 不存在的情况。
- **不复刻 docker 的功能**——网络、额外 mount、env 注入、user 切换，统统让用户用原生 `docker run` 自己组合。
- **不解析 `providers.json` 反推该 forward 哪些 env var**——env-var 形式的 key 让用户用 `docker run -e KEY ...` 自己处理；mount-based key（keys.json）已经覆盖大多数场景。
- **不探测 docker daemon 健康**——`docker` 不在 PATH 我们报 exit 4，其他 docker 错误就让 docker 自己说。

---

## API key 怎么进容器

按优先级三种走法：

### 1. `keys.json`（推荐，零配置）

如果你已经在 host 上跑过 `huko keys set <ref> <value>` 或者 `huko setup`，那 key 已经存在 `~/.huko/keys.json` 或 `<cwd>/.huko/keys.json` 里。**两个目录都被 mount 了**——容器里的 huko 透过 `/root/.huko` 和 `/work/.huko` 自动读到，无需任何额外操作。

### 2. 环境变量（自动 forward）

Wrapper 会**自动**把每个 provider 需要的 env-var 形式 key 透传进容器：

1. 读取 host 上 merged providers 配置（`~/.huko/providers.json` + `<cwd>/.huko/providers.json`）
2. 对每个 provider，按惯例 `<REF>_API_KEY`（参考 `envVarNameFor`）算出 env 变量名
3. 凡是在你当前 shell `process.env` 里**有值**的，加 `-e <NAME>` 给 docker（只传名字不传值，docker 自己去读 host env）

举例：你 `export DEEPSEEK_API_KEY=sk-xxx` + 在配置里有 deepseek provider，那 `huko docker run -- "..."` 自动包含 `-e DEEPSEEK_API_KEY`，容器里的 huko 解析 key 时就能拿到。

边界：
- **只 forward 配置里声明过 apiKeyRef 的变量**，不会盲目 `-e *_API_KEY` 全扫
- 没在 host env 里 set 的（或者 set 成空字符串）跳过——避免容器里覆盖掉它本来能从 mount 拿到的值
- loadInfraConfig 失败（config 文件还没建、JSON 坏了等）→ wrapper 不 forward 任何 env，但仍正常启动，容器内 huko 走 mount 的 keys.json 兜底

### 3. `.env` 文件

`<cwd>/.env` 同样自动可见（在 `/work/.env`），huko 的 key 解析三层会找到它。

---

## 镜像选择

| 优先级 | 来源 | 例子 |
|---|---|---|
| 最高 | `--image <name>` flag | `huko docker run --image myorg/fork:dev -- ...` |
| 中 | `HUKO_DOCKER_IMAGE` env | `export HUKO_DOCKER_IMAGE=myreg/huko:0.2.0` |
| 默认 | 内置 | `ghcr.io/alexzhaosheng/huko:latest` |

### `:latest` vs `:edge` vs `:VERSION`

- **`:latest`**（默认）：最新正式 release 的镜像，由 tag push 触发的 `release.yml` 推到 ghcr.io
- **`:edge`**：main 分支当前快照，每次 main push 自动 rebuild。想试还没发版的最新代码用这个
- **`:0.1.0` / `:0.1`** 等具体版本：每次 release 都会推
- **`:edge-<short-sha>`**：edge 分支某个 commit 的精确镜像，回归测试 / 复现 bug 用

切换示例：
```bash
huko docker run --image ghcr.io/alexzhaosheng/huko:edge -- "..."
huko docker run --image ghcr.io/alexzhaosheng/huko:0.1.0 -- "..."
```
或者 `export HUKO_DOCKER_IMAGE=ghcr.io/alexzhaosheng/huko:edge` 一劳永逸切。

详见 [`docs/cicd.md`](./cicd.md)。

---

## Stateful 与并发

**State 默认持久化**：`/work/.huko/huko.db`、`state.json` 都在 mount 里——跑完 `--rm` 销毁的只是容器进程，会话数据留在 host 文件系统上，下次 `huko docker run -- ...` 接着用。

**并发 / lock**：huko 用 `<cwd>/.huko/lock` 做 per-cwd 互斥。这个 lock 是 PID-based，host 进程和 container 进程 PID 互不可见，所以**同一个 project 同时跑 host 上的 huko 和容器里的 huko 是 unsupported**——会互相覆盖 session、可能写坏 entries。挑一个就行。

---

## 自己 build image

```bash
cd huko/docker
docker build -t huko-local:latest --build-arg HUKO_VERSION=latest .
HUKO_DOCKER_IMAGE=huko-local:latest huko docker run -- "..."
```

或者基于这份 Dockerfile fork——加你自己的工具（aws-cli、kubectl 等等），huko 主流程不会感知。

---

## 常见坑

- **docker 没装** → `huko docker: docker not found in PATH`，exit 4。装 [Docker Desktop](https://docs.docker.com/get-docker/) 或 docker-ce 后重试。
- **第一次跑很慢** → 在 pull 镜像。后续走本地缓存就快了。
- **Windows 下路径** → Docker Desktop 自动处理 Windows 风格路径转 Unix mount，无需额外操作；`-v "$PWD:/work"` 的 `$PWD` 在 PowerShell / cmd 里换成 `${PWD}` 或 `%cd%`。huko docker wrapper 跨平台都用 `process.cwd()`，自己处理。
- **想用 host 的 git 凭据** → `~/.gitconfig` 没自动 mount。要的话用原生 docker run 加 `-v "$HOME/.gitconfig:/root/.gitconfig:ro"`。
- **会话路径权限** → 容器里默认 root 写出来的 `.huko/huko.db` 在 host 上属于 root。Linux 用户可以加 `--user "$(id -u):$(id -g)"`，但要原生 docker run，wrapper 不动这个旋钮（容器内 huko 需要 home dir 写权限，user 切换会引入额外配置）。
