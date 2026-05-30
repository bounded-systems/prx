# prx

`prx` — the agent-run PR contract / work-unit CLI, plus the `@bounded-systems/*`
libraries it builds on. A Bun + TypeScript monorepo.

> Extracted from [`bdelanghe/ai-home`](https://github.com/bdelanghe/ai-home) as a
> fresh, squashed history. ai-home now **consumes** prx (via the nix flake below)
> rather than implementing it.

## Layout

- `packages/prx/` — the CLI (`src/`, `test/`, `scripts/`, `schemas/`)
- `packages/*` — the `@bounded-systems/*` libraries prx depends on (`cas`, `git`,
  `gh`, `env`, `proc`, `bd`, `scout`, …); workspace-internal via `workspace:*`
- `spec/` — the prx effect/contract spec (`schema.cue`)

## Build & test

```bash
bun install
bun test
bun run typecheck
bun run prx:build      # → dist/prx (self-contained binary)
```

## Nix

The flake exposes the compiled binaries as packages:

```bash
nix build .#prx        # → result/bin/prx
nix build .#prx-tui
```

Consumers (e.g. ai-home) wire prx as a flake input and reference
`${prx.packages.<system>.prx}/bin/prx`, injecting `PRX_AI_HOME_ROOT` and
`BAKED_CLAUDE_CODE_PATH` at runtime.

## Publishing

Public `@bounded-systems/*` leaves (e.g. `cas`) are published to npm via
changesets + `.github/workflows/release.yml` (SLSA provenance). See
`docs/companion-repos.md`.
