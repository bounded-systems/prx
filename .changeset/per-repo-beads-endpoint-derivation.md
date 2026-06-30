---
"@bounded-systems/prx": minor
---

`resolveBeadsEndpoint` now derives the beadsd socket from the repo (`git rev-parse --git-common-dir` → `<git-common-dir>/.beads/dolt-server.sock`) instead of falling back through a chain of runtime discoveries. `PRX_BEADS_SOCKET` overrides the derived path (pod routing via `primeHostBeadsDoor` primes this). Missing `.beads/` or a missing socket file now error explicitly with actionable hints — no silent fallbacks to the PRX daemon (prx-z7of).
