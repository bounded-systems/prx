# @bounded-systems/host

## 0.2.0

### Minor Changes

- 37b0b70: Make the Tier-1 packages publish-ready as standalone packages.

  For each of `auth`, `host`, `proc`, and `surface-sync`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`.

  These depend only on already-packaged leaves (`auth`/`host` → `env`; `proc` → `env`, `policy`; `surface-sync` → `disposition`). Each build's `tsconfig.build.json` overrides `paths: {}` so those workspace deps resolve as external dependencies (their built declarations) rather than being pulled in as source. No code changes; all four already carried extractability tests.

## 0.0.1

### Patch Changes

- Updated dependencies [2f4b731]
  - @bounded-systems/env@0.2.0
