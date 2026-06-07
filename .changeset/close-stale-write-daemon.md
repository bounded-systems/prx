---
"@bounded-systems/prx": patch
---

feat(triage): route close-stale's WRITE through the daemon (GH-296)

`triage close-stale` closed stale beads with host `bd update -s closed --notes …`
against the per-clone `.beads`. Its write now runs `prx beads close <id> --reason …`
through the daemon (the trusted single writer; maps daemon-side to
`bd update --status closed --notes`). A sync subprocess keeps `runTriageCloseStale`
synchronous (no async ripple to its 14 call sites / the CLI), matching the prx-fda
read pattern; the runner is injectable for tests. Another bulk write reconciler
off host bd, toward prx-82b.
