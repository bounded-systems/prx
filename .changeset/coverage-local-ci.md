---
"@bounded-systems/prx": patch
---

test(prx): cover the `prx ci` (local-ci) phase internals via a `{ run, capture }` subprocess seam

`phaseSpec` and `runPhase` now accept an optional `LocalCiRunners` seam
(defaulting to the real `defaultRunner`/`runCaptured`) and are exported, so the
spec-building, git-SHA bake, dist-dir prepare, and plain/json phase dispatch are
testable without spawning the heavy `bun`/`git` tools. Behavior is unchanged for
existing callers. Coverage 37% → 100%.
