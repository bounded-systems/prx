# Build & release

Decisions for the `bounded-systems/prx` monorepo (2026-05-30).

## Build tool: bun (kept)

prx is built with **bun** (`bun build --compile` → a self-contained binary;
`bun:test`; bun workspaces for the `@bounded-systems/*` libs). Kept as-is.

Alternatives considered and **deferred** (not worth the migration now):
- **deno** — friendlier nix story (`deno vendor` is fixed-output-derivable,
  `deno compile`), but switching means rewriting imports, swapping `bun:test` →
  `deno test`, and redoing the workspace. A months-long, high-risk migration with
  low payoff once distribution is release-binary (below). Revisit only as its own
  initiative if bun becomes a real constraint.
- **moon (moonrepo)** — a task/build orchestrator over bun, not a runtime. Doesn't
  solve the distribution/nix question; adds a layer. Consider only if multi-package
  task orchestration becomes a need.

## Distribution: release-binary (primary)

The **primary artifact is the compiled binary**, published to the GitHub Release on
a semver tag by `.github/workflows/release-binary.yml` (bun builds in a normal CI
runner — no nix sandbox involved, so the bun-in-nix-FOD problem never arises).

Consumers install the released binary directly (download / install script; later:
brew, `bun install -g`, etc.). **nix is not required to build or install prx** — it
is *one* install path among several.

## Consuming from nix (ai-home)

ai-home (home-manager) installs prx by fetching the released binary via
`pkgs.fetchurl` (a single-file fixed-output derivation — hermetic, works under
`sandbox = true`, no `nix.conf` tweak). This is the "use nix to install the
released package" path. The from-source `flake.nix` is a **dev convenience only**
(impure `nix build`, needs `sandbox = relaxed`); it is not the distribution
mechanism.

## Versioning: semver via changesets

Releases are **semantic-versioned**. `changesets` (`.changeset/config.json`) drives
version bumps + changelogs and the npm publish of public `@bounded-systems/*`
libraries (`release.yml`). A semver tag (`vX.Y.Z`) triggers both the library npm
publish and the `release-binary` workflow. Pre-1.0 (`0.x`) while the surface is
still moving; promote to `1.0.0` when the CLI contract stabilizes.
