---
"@bounded-systems/repo-root": minor
"@bounded-systems/github-budget": minor
"@bounded-systems/scout": minor
"@bounded-systems/slack": minor
"@bounded-systems/bd": minor
"@bounded-systems/gh": minor
"@bounded-systems/git": minor
---

Make the Tier-2 packages publish-ready as standalone packages.

For each of `repo-root`, `github-budget`, `scout`, `slack`, `bd`, `gh`, and `git`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`. Each build's `tsconfig.build.json` overrides `paths: {}` so workspace deps resolve as external built declarations.

All seven depend only on already-packaged packages, and all already carried extractability tests. Also fixes three undeclared-dependency gaps surfaced while packaging (each was imported but not declared, which would break a standalone install):

- `repo-root` now declares `@bounded-systems/proc`.
- `scout` now declares `@bounded-systems/anchored-chain-sqlite`.
- `slack` now declares `@bounded-systems/anchored-chain-sqlite`, `@bounded-systems/auth`, `@bounded-systems/env`, and `@bounded-systems/proc`.
