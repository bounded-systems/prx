# Multi-stage build for the prx CLI container image (published to GHCR).
# Build stage compiles the self-contained binary with bun; runtime stage is a
# slim Debian base with the tools prx shells out to (git, gh, ca-certificates).
ARG BUN_VERSION=1.3.11

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# GIT_SHA is passed by CI so `prx --version` reports the source commit.
ARG GIT_SHA=dev
RUN PRX_COMPILE_GIT_SHA="${GIT_SHA}" BUN="$(which bun)" \
      bun packages/prx/scripts/prx-compile.ts /out/prx \
    && /out/prx --version

FROM debian:stable-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gh ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/prx /usr/local/bin/prx
ENTRYPOINT ["/usr/local/bin/prx"]
CMD ["--help"]
