# CI/CD Design and Status

> This document is the source of truth. Update it whenever workflows or the release process change.

---

## Overall Design

CI/CD is split into three independent workflows:

| Phase | Workflow | Trigger | Status |
|---|---|---|---|
| 1 | **CI**: lint, cross-platform tests, docker sanity | PR / main push | Implemented |
| 2 | **edge-image**: docker `:edge` | main push | Implemented |
| 3 | **release**: npm plus docker `:VERSION` and `:latest` | tag push | Workflow implemented, not yet exercised |

The rollout order was 2 -> 1 -> 3: first unblock Docker-path testing without local builds, then add cross-platform protection, then add the stable release flow. Phase 3 is written, but the first release has not yet been cut; use the first-release checklist below before pushing the first tag.

---

## Phase 2: `edge-image`

### Files

- `.github/workflows/edge-image.yml`
- `docker/Dockerfile`, a multi-stage build from source that does not require npm publishing first

### Trigger

- Push to `main` when source, Dockerfile, or this workflow changes.
- Manual `workflow_dispatch` for repairing workflow changes.

### Behavior

1. Checkout.
2. Set up QEMU so x86 runners can emulate arm64.
3. Set up Buildx.
4. Log in to GHCR with `secrets.GITHUB_TOKEN`.
5. Build and push `ghcr.io/alexzhaosheng/huko:edge`, plus `:edge-${SHA}` for exact testing.
6. Build multi-arch images for `linux/amd64` and `linux/arm64`.
7. Run a smoke test: `docker run :edge-${SHA} huko --help | head -5`.
8. Use `cancel-in-progress` so newer pushes cancel older in-flight edge builds.

### Usage

```bash
docker pull ghcr.io/alexzhaosheng/huko:edge
huko docker run -- "your prompt"
huko docker run --image ghcr.io/alexzhaosheng/huko:edge-<sha> -- "..."
```

After the first push, make the GHCR package public in GitHub package settings so anonymous pulls work.

### Cost

- Each main push takes about 8-15 minutes because arm64 emulation is slow.
- `paths:` filters doc-only changes.
- GitHub Actions cache reduces repeated builds from roughly 12 minutes to roughly 5 minutes for incremental changes.

`:latest` is the default after v0.1.0. Before v0.1.0, the default was `:edge` during the bridge period.

---

## Phase 1: CI

### File

- `.github/workflows/ci.yml`

### Trigger

- Any PR.
- Push to `main`.
- Manual `workflow_dispatch`.

### Jobs

**`test` matrix: Ubuntu, macOS, Windows on Node 24**

1. Checkout.
2. Set up Node and npm cache.
3. `npm ci`.
4. `npx tsc --noEmit`.
5. `npm test`.
6. `npm run build:cli`.

`fail-fast: false` keeps all OS results visible. Concurrency cancels older runs for the same PR ref.

**`docker-build` on Linux only**

1. Set up Buildx.
2. Build `linux/amd64` locally without pushing.
3. Smoke test with `docker run --rm huko:ci-sanity --help | head -5`.

This catches Dockerfile regressions before merge. The smoke test intentionally uses a leading `--help` argv shape because that reproduced an earlier ENTRYPOINT bug.

### Why Three Platforms plus Docker

- `bash.ts` has separate cmd.exe and bash paths.
- `commands/docker.ts` resolves `docker.exe` versus `docker`.
- `commands/run.ts` stdin and `fstatSync` behavior differs on Windows.
- Dockerfile mistakes only show up during docker build/run.

### Relationship to `edge-image`

CI and edge-image are independent. CI failure does not block edge-image, and edge-image failure does not affect PR status. If strict sequencing is needed later, add branch protection or move edge-image to `workflow_run`.

### Cost

- Public repository GitHub Actions are free.
- A full CI run takes about 5-8 minutes.
- The docker-build job usually takes 1-2 minutes with cache.

---

## Phase 3: Release

### File

- `.github/workflows/release.yml`

### Trigger

- Push a tag like `v*.*.*`.
- Manual `workflow_dispatch` with a selected tag for retry or repair.

### Jobs

**`preflight`**

Verifies the tag matches `package.json.version`, catches wrong-commit tags and forgotten version bumps, and derives whether the tag is a prerelease.

**`npm-publish`**

- Uses `actions/setup-node` with `registry-url=https://registry.npmjs.org`.
- Runs `npm ci`.
- Runs `npm publish --provenance --access public`.
- Relies on `prepublishOnly` for check and CLI build.
- Uses `secrets.NPM_TOKEN`.

**`docker-publish`**

- Builds multi-arch images for linux/amd64 and linux/arm64.
- Passes `HUKO_VERSION`.
- Publishes `:VERSION` always, `:MAJOR.MINOR` for stable releases, and `:latest` for stable releases.
- Runs a `docker run :VERSION --help` smoke test.

**`github-release`**

Creates GitHub release notes with npm install and docker pull commands.

### Concurrency and Failure Handling

Only one release runs at a time, and in-progress releases are never cancelled. npm and Docker publish concurrently; if one fails, fix that side and rerun with `workflow_dispatch`.

CI is not a hard gate. The convention is to cut tags from green main commits. Enforce this later with branch protection if needed.

---

## First-Release Checklist

### 1. NPM preparation

- [ ] Run `npm login` and `npm whoami`.
- [ ] Check package-name availability:

  ```bash
  npm view huko 2>&1 | head -1
  ```

- [ ] Generate an npm automation token.
- [ ] Add repository secret `NPM_TOKEN`.

If using a scoped package name, keep `--access public`.

### 2. Bridge cleanup

- [x] Change `server/cli/commands/docker.ts:DEFAULT_IMAGE` from `:edge` to `:latest`.
- [x] Update the `DEFAULT` constant in `tests/docker-parse.test.ts`.
- [x] Update the default-image line in `docs/docker.md`.
- [x] Mark this checklist item done.
- [x] Commit with a message like `chore: switch DEFAULT_IMAGE to :latest ahead of v0.1.0 release`.

### 3. Version and changelog

- [ ] `npm version 0.1.0 --no-git-tag-version`.
- [ ] Optionally write `CHANGELOG.md`.
- [ ] Commit as `chore(release): v0.1.0`.

### 4. Tag and push

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

### 5. Verify after release

- [ ] `npm install -g @alexzhaosheng/huko@0.1.0` works.
- [ ] `docker pull ghcr.io/alexzhaosheng/huko:0.1.0` works.
- [ ] `docker pull ghcr.io/alexzhaosheng/huko:latest` works and points to the same digest.
- [ ] GitHub Releases has a v0.1.0 entry.
- [ ] `huko docker run -- "hi"` works with the default `:latest`.

### 6. Recovery

- If npm publish fails but Docker succeeds, fix npm credentials or naming and rerun the npm side.
- If Docker fails but npm succeeds, fix Docker and rerun that side.
- If preflight fails, delete the bad tag, fix `package.json.version`, and tag again.

---

## Local Docker Verification

```bash
cd huko
docker buildx build --platform linux/amd64 -f docker/Dockerfile -t huko-local:dev .
HUKO_DOCKER_IMAGE=huko-local:dev huko docker run -- "say hi in 3 words"
docker rmi huko-local:dev
```

---

## Workflow Dependencies

| Workflow | Depends on | Used by |
|---|---|---|
| ci | None | PR and push checks; release convention |
| edge-image | None | Users testing `huko docker run` |
| release | npm and GHCR secrets | Users installing npm packages and versioned Docker images |

edge-image intentionally does not depend on CI. The edge image is the current main snapshot; quality responsibility lives in PR review and CI.

---

## Troubleshooting

### `edge-image` fails

1. **Build OOM:** `node:24-alpine`, better-sqlite3, and arm64 QEMU can be tight. Reproduce amd64-only first.
2. **GHCR push 403:** set repository workflow permissions to read/write.
3. **Smoke test fails:** reproduce locally with `docker run --platform linux/amd64 ghcr.io/alexzhaosheng/huko:edge-<sha> huko --help`.
4. **Package is still private:** make the GHCR package public after the first push.

### Users cannot pull the image

`manifest unknown` means the image has not been pushed. Check the Actions tab for the edge-image workflow.

### `huko docker run` cannot find Docker

The contract is exit 4 plus an install-Docker message. This is expected.

### CI test job fails only on Windows

The likely causes are native better-sqlite3 compilation problems or path/glob assumptions. Node 24 should use prebuilt binaries when available; if node-gyp runs, Windows needs Visual Studio Build Tools.

### CI docker-build fails

CI and edge-image use the same Dockerfile. A CI docker-build failure means amd64 Docker is broken. arm64-only issues appear in edge-image.

### npm publish 401 / 403

- 401 usually means `NPM_TOKEN` is missing, expired, or the wrong type.
- 403 usually means the package name is unavailable. Use the scoped package `@alexzhaosheng/huko`.

### npm publish E422 for private GitHub repositories

`--provenance` requires a public GitHub repository. Either make the repo public or remove `--provenance` and `id-token: write`.

### Preflight fails because tag and package version differ

Delete the tag, bump `package.json.version`, and tag again. Do not move the same tag without fixing the commit.
