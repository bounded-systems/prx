# @bounded-systems/git

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
  - @bounded-systems/proc@0.2.0

## 0.0.2

### Patch Changes

- Updated dependencies [2f4b731]
  - @bounded-systems/env@0.2.0
  - @bounded-systems/policy@0.2.0
  - @bounded-systems/fs@0.2.0
  - @bounded-systems/proc@0.0.1

## 0.0.1

### Patch Changes

- e6ce632: `execGit` commits/tags headless-safe: inject `-c commit.gpgsign=false` /
  `-c tag.gpgsign=false` at the single git seam. prx's provenance signing is ed25519
  over the chain (keeper's commit-tree), never git's gpg/ssh commit signing — which
  is the operator's config and fails in non-interactive/agent contexts (e.g. 1Password
  SSH: "agent returned an error" → "failed to write commit object"). This makes every
  prx git caller (keeper, `prx tools git`, the executor leg) robust regardless of the
  operator's `commit.gpgsign` — the production counterpart to the test-fixture
  hermetic fix (GH-360/GH-388).
