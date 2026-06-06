---
"@bounded-systems/prx": minor
---

beadsd — beads as a capability-isolated daemon (GH-228/GH-296)

Run beads behind a daemon so the host (human + agents) queries one source instead
of N drifting per-worktree dolt clones:

- `prx lima up|down|daemons|status` — manage in-VM daemons (keeper + beads) over a
  daemon registry; `prx lima provision-beads <vm> --origin <owner/repo>` installs
  bd+dolt and clones the canonical beads into a Lima VM.
- `prx beads serve` (in-VM read+write daemon: ready/list/show/create/update/close,
  single-writer under the bd policy gate) and `prx beads ready|list|show --vm`
  (host read-door over the Lima-SSH channel).
- `prx beads doctor [--fix]` — diagnose / re-bootstrap an unhealthy beads clone.
- Config-driven dolt-database namespace resolver (reverse-DNS is now a swappable
  policy, decoupled from the SQL-safety guard).

Validated end-to-end against a real Lima VM (local + VM e2e tests).
