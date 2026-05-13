# Running `huko` in Docker

> `server/cli/commands/docker.ts` + `docker/Dockerfile`

## One-Liner

```bash
huko docker run -- "fix the bug in main.ts"
```

This is equivalent to:

```bash
docker run --rm -i \
  -v "$PWD:/work" \
  -v "$HOME/.huko:/root/.huko" \
  --workdir /work \
  ghcr.io/alexzhaosheng/huko:edge \
  -- "fix the bug in main.ts"
```

The image `ENTRYPOINT` is `["huko"]`, so Docker positional arguments become huko argv. `docker run ... <image> sessions list` runs `huko sessions list`; `docker run ... <image> -- "prompt"` runs `huko -- "prompt"`.

The `huko docker run` wrapper only removes the need to type the volume and workdir template. All other semantics match normal huko: same flags, same `--` sentinel, and the same pipe-friendly stdin behavior.

---

## What It Does

1. **Adds three fixed mounts.** These are part of the convention and cannot be disabled.

| Host | Container | Purpose |
|---|---|---|
| `$PWD` | `/work` | Project directory, including `.huko/huko.db`, `.huko/keys.json`, and source files |
| `$HOME/.huko` | `/root/.huko` | Global infra config such as providers, keys, and config |
| n/a | `--workdir /work` | Aligns the inner huko cwd with the host cwd |

2. **Passes stdin/stdout through.** The wrapper uses `-it` for TTY sessions and `-i` for piped input, so both `cat data | huko docker run -- "..."` and interactive modes work naturally.
3. **Supports `--image <name>`**, with `HUKO_DOCKER_IMAGE` as an env override.
4. **Propagates exit codes.** Docker's exit code becomes huko's exit code. If Docker exits from a signal, huko re-raises the signal so the shell sees the standard Unix `128 + signo` result.

## What It Does Not Do

- It does not automatically build or pull the image. Docker reports missing images itself.
- It does not reimplement Docker. Extra networks, mounts, env injection, and user switching stay in native `docker run`.
- It does not parse providers and guess every env var. Mount-based keys cover most cases; env-var keys can be passed through native Docker when needed.
- It does not health-check the Docker daemon. Missing `docker` exits with code 4; other Docker failures are reported by Docker.

---

## How API Keys Enter the Container

### 1. `keys.json` - recommended

If the host has already run `huko keys set <ref> <value>` or `huko setup`, keys exist in `~/.huko/keys.json` or `<cwd>/.huko/keys.json`. Both directories are mounted, so the container reads them automatically.

### 2. Environment variables - automatic forwarding

The wrapper forwards configured provider env-var keys:

1. Read merged provider config from `~/.huko/providers.json` and `<cwd>/.huko/providers.json`.
2. Compute the env var name by convention, such as `<REF>_API_KEY`.
3. If that variable exists in the host shell, pass `-e <NAME>` to Docker.

Only variables declared by provider config are forwarded. Empty or missing variables are skipped, and config read failures simply fall back to mounted `keys.json`.

### 3. `.env`

`<cwd>/.env` is visible as `/work/.env`, and huko's key lookup can read it there.

---

## Image Selection

| Priority | Source | Example |
|---|---|---|
| Highest | `--image <name>` flag | `huko docker run --image myorg/fork:dev -- ...` |
| Middle | `HUKO_DOCKER_IMAGE` env | `export HUKO_DOCKER_IMAGE=myreg/huko:0.2.0` |
| Default | Built-in value | `ghcr.io/alexzhaosheng/huko:latest` |

### `:latest`, `:edge`, and `:VERSION`

- `:latest` is the default stable release image, updated by `release.yml`.
- `:edge` is the current `main` snapshot and rebuilds on every main push.
- `:0.1.0`, `:0.1`, and similar tags are release images.
- `:edge-<short-sha>` pins one exact edge commit for regression testing or reproduction.

```bash
huko docker run --image ghcr.io/alexzhaosheng/huko:edge -- "..."
huko docker run --image ghcr.io/alexzhaosheng/huko:0.1.0 -- "..."
export HUKO_DOCKER_IMAGE=ghcr.io/alexzhaosheng/huko:edge
```

See [cicd.md](./cicd.md).

---

## State and Concurrency

State persists by default because `/work/.huko/huko.db` and `state.json` are mounted from the host. `--rm` removes only the container process; session data remains on the host.

Concurrency is intentionally limited. huko uses `<cwd>/.huko/lock` for per-cwd mutual exclusion. Host and container PIDs are not mutually visible, so running host huko and container huko against the same project at the same time is unsupported.

---

## Build Your Own Image

```bash
cd huko/docker
docker build -t huko-local:latest --build-arg HUKO_VERSION=latest .
HUKO_DOCKER_IMAGE=huko-local:latest huko docker run -- "..."
```

You can fork the Dockerfile to add tools such as aws-cli or kubectl. The main huko flow does not need to know.

---

## Common Pitfalls

- **Docker is not installed:** `huko docker: docker not found in PATH`, exit 4. Install Docker Desktop or docker-ce and retry.
- **First run is slow:** the image is being pulled. Later runs use the local cache.
- **Windows paths:** Docker Desktop handles Windows-to-Unix mount conversion. Native `docker run` examples need `${PWD}` in PowerShell or `%cd%` in cmd. The wrapper uses `process.cwd()` and is cross-platform.
- **Host git credentials:** `~/.gitconfig` is not mounted automatically. Use native Docker with `-v "$HOME/.gitconfig:/root/.gitconfig:ro"` if needed.
- **Session file ownership:** on Linux, root-written `.huko/huko.db` may be owned by root on the host. Native Docker can use `--user "$(id -u):$(id -g)"`; the wrapper does not expose that control.
