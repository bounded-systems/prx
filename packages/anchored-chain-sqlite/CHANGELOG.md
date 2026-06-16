# @bounded-systems/anchored-chain-sqlite

## 0.2.0

### Minor Changes

- 8c1b8c5: Make the anchored-chain provenance stack publish-ready as standalone packages.

  For both `@bounded-systems/anchored-chain` (the pure core) and `@bounded-systems/anchored-chain-sqlite` (the SQLite/Drizzle store): drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts), plus a README and LICENSE.

  - `anchored-chain` builds a normal dist (`exports` resolve `bun`→src and `types`/`import`→dist), mirroring `@bounded-systems/cas`. Its only dependency is `cas`.
  - `anchored-chain-sqlite` is Bun-only (`bun:sqlite`, `drizzle-orm/bun-sqlite`, `.sql`/`.json` import attributes), so its runtime `exports` resolve to source under the `bun` condition and `dist` carries type declarations only (`engines.bun` is declared).

### Patch Changes

- Updated dependencies [8c1b8c5]
  - @bounded-systems/anchored-chain@0.2.0
