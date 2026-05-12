# syntax=docker/dockerfile:1
#
# Container image for `huko` — published to ghcr.io/alexzhaosheng/huko.
# Designed to run with the canonical wrapper:
#
#   docker run --rm -i \
#     -v "$PWD:/work" \
#     -v "$HOME/.huko:/root/.huko" \
#     --workdir /work \
#     ghcr.io/alexzhaosheng/huko:latest -- "your prompt"
#
# `huko docker run -- "your prompt"` builds exactly that argv for you.
# See docs/docker.md for the full convention.

FROM node:24-alpine

# Tools the agent needs to actually be useful: a real shell, git for
# read/write, curl for fetches the WebFetch tool delegates to. Add to
# this list ONLY for things broadly useful — keep the image small.
RUN apk add --no-cache bash git curl ca-certificates

# huko itself. Pin via build-arg so the same Dockerfile produces a
# reproducible build per release: `docker build --build-arg HUKO_VERSION=0.1.0 ...`.
ARG HUKO_VERSION=latest
RUN npm install -g huko@${HUKO_VERSION}

# /work is the project mount point. The wrapper sets --workdir /work
# explicitly; setting WORKDIR here too means a bare `docker run image`
# (no wrapper) lands in the right place.
WORKDIR /work

# No ENTRYPOINT — we want users (and the wrapper) to be able to invoke
# arbitrary `huko` subcommands without quoting around an entrypoint
# wrapper. CMD defaults to showing usage.
CMD ["huko", "--help"]
