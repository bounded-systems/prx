---
"@bounded-systems/prx": patch
---

Fix `nextWork` triggering a `bd`/`gh` subprocess from a non-repo path. `loadTriageSnapshot` short-circuited only when **both** `.git` and `prx.toml` were absent — so a directory holding only a `prx.toml` (no git working tree) fell through and spawned `runStatusActor` → `bd`/`gh`, which hangs when no daemon/auth is present. Triage genuinely needs a git working tree, so the guard now gates on `.git` alone (a dir in the main repo, a file in a worktree). Pure-config callers (e.g. the `[next_work]` config-reader path) short-circuit cleanly instead of hanging.
