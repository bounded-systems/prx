# @bounded-systems/gh

## 0.1.0

### Minor Changes

- 94255ea: Make the Tier-2 packages publish-ready as standalone packages.

  For each of `repo-root`, `github-budget`, `scout`, `slack`, `bd`, `gh`, and `git`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`. Each build's `tsconfig.build.json` overrides `paths: {}` so workspace deps resolve as external built declarations.

  All seven depend only on already-packaged packages, and all already carried extractability tests. Also fixes three undeclared-dependency gaps surfaced while packaging (each was imported but not declared, which would break a standalone install):

  - `repo-root` now declares `@bounded-systems/proc`.
  - `scout` now declares `@bounded-systems/anchored-chain-sqlite`.
  - `slack` now declares `@bounded-systems/anchored-chain-sqlite`, `@bounded-systems/auth`, `@bounded-systems/env`, and `@bounded-systems/proc`.

### Patch Changes

- Updated dependencies [37b0b70]
- Updated dependencies [94255ea]
  - @bounded-systems/proc@0.2.0
  - @bounded-systems/github-budget@0.1.0

## 0.0.2

### Patch Changes

- Updated dependencies [2f4b731]
  - @bounded-systems/env@0.2.0
  - @bounded-systems/policy@0.2.0
  - @bounded-systems/github-budget@0.0.1
  - @bounded-systems/proc@0.0.1

## 0.0.1

### Patch Changes

- df7cb2e: Additive testability seams + a dead-code dedupe, all behavior-preserving:

  - `@bounded-systems/gh` — `execGh` gains optional `deps.spawn` / `deps.budget`
    seams so the rate-limit authority boundary is testable without a live `gh`
    spawn or real GitHub budget state. Existing call sites pass nothing.
  - `@bounded-systems/bd` — removed the redundant static `BLOCKED_SUBCOMMANDS`
    check (the policy `isBlocked` gate already enforced the identical list);
    policy is now the single source of truth, pinned by a `blockedSubcommands`
    parity test.
  - `@bounded-systems/prx` — `execWorktrunk`, `runClaudePreflight`, and
    `runHookVerb`/`readStdin` gain optional injectable spawn/exec/stdin seams
    (default to the real implementations) so their subprocess/stdin boundaries
    are unit-testable.
