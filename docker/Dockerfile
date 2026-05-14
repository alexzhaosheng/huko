# syntax=docker/dockerfile:1
#
# Container image for `huko` — published to ghcr.io/alexzhaosheng/huko.
# Designed to run with the canonical wrapper:
#
#   docker run --rm -i \
#     -v "$PWD:/work" \
#     -v "$HOME/.huko:/root/.huko" \
#     --workdir /work \
#     ghcr.io/alexzhaosheng/huko:edge \
#     -- "your prompt"
#
# `huko docker run -- "your prompt"` builds exactly that argv for you.
# See docs/docker.md for the full convention and docs/cicd.md for how
# this image gets published.
#
# Multi-stage build: builder compiles native deps + esbuild bundle,
# runtime stage drops build tools so the published image stays small.
# Multi-arch (linux/amd64 + linux/arm64) handled by buildx + QEMU in
# .github/workflows/edge-image.yml — the build runs INSIDE the target
# arch so better-sqlite3's native module gets built correctly.

ARG NODE_VERSION=24

# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

# Native build tools for better-sqlite3 (the only dep that compiles
# native code) + `git`, which `scripts/build-cli.mjs` invokes via
# `git rev-parse --short HEAD` to embed the commit SHA into the
# bundle. The COPY below brings `.git/` in (no .dockerignore excludes
# it); without the `git` binary the script silently returns
# "unknown" and the build-check at the end of build-cli.mjs aborts.
# All of these get dropped from the runtime image entirely.
RUN apk add --no-cache python3 make g++ git

WORKDIR /src

# Install pnpm via corepack (bundled with Node 24). Copy package files
# first so install can be cached when only source changes. Native
# module compile (better-sqlite3) happens here.
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Now the source. Build the esbuild bundle, then prune devDeps so the
# node_modules we ship to runtime is the minimal prod set.
COPY . .
RUN pnpm run build:cli && pnpm prune --prod

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine

# Tools the agent actually needs to be useful: a real shell (the bash
# tool spawns it explicitly), git for read/write workflows, curl for
# the WebFetch tool's network operations, and CA bundle so HTTPS works
# without surprises.
RUN apk add --no-cache bash git curl ca-certificates

# Copy the built tree wholesale — it's already pruned to prod-only.
COPY --from=builder /src /opt/huko

# Symlink instead of `npm install -g .` — same result, no lifecycle
# hooks, no second download.
RUN ln -s /opt/huko/bin/huko.mjs /usr/local/bin/huko

# /work is the project mount point. The wrapper sets --workdir /work
# explicitly; setting WORKDIR here too means a bare `docker run image`
# (without the wrapper) lands in the right place.
WORKDIR /work

# Override the inherited ENTRYPOINT (`docker-entrypoint.sh` from the
# node base image), which prepends `node` to any arg starting with
# `-`. Without this override the wrapper's `-- "<prompt>"` becomes
# `node -- "<prompt>"`, and node tries to load `<prompt>` as a script.
#
# With ENTRYPOINT=["huko"], `docker run <image> [args...]` becomes
# `huko [args...]` — exactly the contract the wrapper expects, and
# the same as users typing `huko ...` on the host. CMD provides the
# default args when none are given (`docker run <image>` alone).
ENTRYPOINT ["huko"]
CMD ["--help"]
