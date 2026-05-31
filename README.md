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

## Install

prx ships as a **released binary** (per platform) attached to each GitHub
release, plus a container image at `ghcr.io/bounded-systems/prx`. Distribution
is the binary — nix is one install path among several.

### Nix flake (hermetic)

The flake's packages are the released binaries fetched via `fetchurl`, so they
build under `sandbox = true` with no `nix.conf` changes:

```bash
nix run github:bounded-systems/prx -- --version
nix build github:bounded-systems/prx#prx       # → result/bin/prx
nix build github:bounded-systems/prx#prx-tui
```

### home-manager (portable module)

Any home-manager config can install prx via the exported module:

```nix
{
  inputs.prx.url = "github:bounded-systems/prx";

  # in your home-manager configuration's modules list:
  modules = [ prx.homeManagerModules.default ];
}
```

```nix
# then, in a home-manager module:
programs.prx = {
  enable = true;
  # optional consumer wiring the released binary does not bake:
  aiHomeRoot = "${config.home.homeDirectory}/.config/ai-home"; # PRX_AI_HOME_ROOT
  claudePath = "${config.home.homeDirectory}/.local/bin/claude"; # BAKED_CLAUDE_CODE_PATH
  installTui = true;   # also install prx-tui
  installWt  = true;   # also install the `wt` worktree wrapper
};
```

This installs `prx` + `repox` (and optionally `prx-tui` / `wt`) into
`~/.local/bin`. The per-release sha256s live in `release-hashes.json`, updated
automatically by the `release-binary` workflow on each tag.

## Publishing

Public `@bounded-systems/*` leaves (e.g. `cas`) are published to npm via
changesets + `.github/workflows/release.yml` (SLSA provenance). See
`docs/companion-repos.md`.
