---
"@bounded-systems/prx": patch
---

chore: delete the `@bounded-systems/prx-mux` package (slice 4 of removing tmux entirely). After slices 1–3 removed every tmux caller, the package had no remaining consumers in `packages/prx/src` except a re-export of `CommandRunner`/`defaultRunner` from `@bounded-systems/proc`. Those imports (`gh-pr-fetcher` + example + test) are repointed directly at `@bounded-systems/proc`; the package is removed from the workspace deps + tsconfig paths and deleted along with its tests.
