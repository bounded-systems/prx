---
---

Apply the Biome formatter across the hand-written TypeScript (the deferred
reformat from #691) and graduate the first two lint rules — `noFocusedTests` and
`noDoubleEquals` — from `warn` to `error`, now that both are at zero. Formatting
plus lint-config only: no behavior change, no package release.
