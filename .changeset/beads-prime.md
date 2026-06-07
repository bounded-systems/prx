---
"@bounded-systems/prx": patch
---

Add `prx beads prime` — the daemon-aware session primer (the prx-beads twin of `bd prime`, GH-296). It prints how to reach beads (`prx beads <verb>` through the per-repo daemon, not raw `bd`) plus live ready-work from the daemon. Resilient by design: an unreachable daemon still prints the guidance and exits 0, so it's safe as a SessionStart hook. This is the in-repo enabler for repointing the SessionStart hook off raw `bd prime`.
