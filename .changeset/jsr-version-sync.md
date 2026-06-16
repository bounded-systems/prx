---
---

Add `jsr-version-sync` so `jsr.json` versions stay in lockstep with `package.json`.

`changesets` bumps `package.json`, but JSR reads the version from `jsr.json` at publish time, so the two had drifted (20 of 22 packages). `packages/prx/scripts/jsr-version-sync.ts` makes `package.json` the single source of truth: `bun run jsr:versions:check` (CI guard) and `bun run jsr:versions` (rewrite). `version-packages` now runs the sync, and the drifted `jsr.json` files are realigned. No package versions change. Adds a JSR publishing runbook (`docs/prx/package-publishing.md`).
