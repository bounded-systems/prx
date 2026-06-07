---
"@bounded-systems/prx": patch
---

beadsd now keeps its served clone fresh (GH-296): `runBeadsServe` runs an injected `refresh` on start and every 5 minutes, and `prx beads serve --cwd <clone>` wires that to `bd dolt pull` in the served clone. Refresh errors are swallowed (a stale-but-up daemon beats a crashed one); conflict resolution against local writes is left to the sync agent. So a long-lived local daemon no longer serves indefinitely-stale beads.
