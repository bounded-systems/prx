---
"@bounded-systems/verbspec": minor
---

Make `@bounded-systems/verbspec` publish-ready as a standalone package.

Drop `private`, add the publish metadata (MIT license, repository/homepage/bugs, keywords, `files`, `publishConfig`), a dist build (`tsconfig.build.json` + `build`/`prepublishOnly` scripts; `exports` resolve `bun`→src and `types`/`import`→dist), a README and LICENSE, and an extractability test guarding outward-only imports and no ambient authority. `toHelp` and `dispatch` take an optional `bin` argument (defaults to `"prx"`) so the CLI projection is no longer hardcoded to the prx binary name; existing callers are unaffected.
