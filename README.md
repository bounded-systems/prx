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

### Homebrew

This repo doubles as a tap (it has a `Formula/`), so:

```bash
brew tap bounded-systems/prx https://github.com/bounded-systems/prx
brew install prx
```

(The explicit tap URL is needed because the repo is `prx`, not `homebrew-prx`.)

### Nix flake (hermetic)

The flake's packages are the released binaries fetched via `fetchurl`, so they
build under `sandbox = true` with no `nix.conf` changes:

```bash
nix run github:bounded-systems/prx -- --version
nix build github:bounded-systems/prx#prx       # → result/bin/prx
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
  installWt  = true;   # also install the `wt` worktree wrapper
};
```

This installs `prx` (and optionally `wt`) into
`~/.local/bin`. The per-release sha256s live in `release-hashes.json`, updated
automatically by the `release-binary` workflow on each tag.

## Publishing

Public `@bounded-systems/*` leaves (e.g. `cas`) are published to npm via
changesets + `.github/workflows/release.yml` (SLSA provenance). See
`docs/companion-repos.md`.

## Community & governance

- [`LICENSE`](LICENSE) — see below
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to build, test, and propose changes
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [`SECURITY.md`](SECURITY.md) — report vulnerabilities privately

These files, the `.github/` issue + pull-request templates, and their shared
facts (project, copyright, security contact, supported versions) are
**generated** from `packages/prx/community/` — edit `community.json` (validated
against a JSON Schema with ajv) or the pinned templates, then
`bun run community:render`. `bun run community:check` (and the test suite) fail
on drift, so the governance docs can't fall out of sync.

## License

`prx` is **source-available**, not OSI open-source. It is licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
(`PolyForm-Noncommercial-1.0.0`): free for any **noncommercial** use, with all
commercial rights reserved to the copyright holder. For a commercial license,
contact the maintainer at <https://github.com/bdelanghe>. See [`LICENSE`](LICENSE).
