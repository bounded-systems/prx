---
"@bounded-systems/env": minor
"@bounded-systems/policy": minor
"@bounded-systems/disposition": minor
"@bounded-systems/audit-context": minor
"@bounded-systems/fs": minor
"@bounded-systems/machine-schema": minor
"@bounded-systems/prx-config": minor
---

Make the remaining leaf packages publish-ready as standalone packages.

For each of `env`, `policy`, `disposition`, `audit-context`, `fs`, `machine-schema`, and `prx-config`: drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`) and a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), plus a README and LICENSE — mirroring `@bounded-systems/cas`.

These are all true leaves (no internal `@bounded-systems` dependencies). Additionally:

- `machine-schema` and `prx-config` gain the extractability test the other leaves already had.
- `prx-config` now declares its `zod` peer dependency (it imported `zod` without declaring it).
