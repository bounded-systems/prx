---
---

Add regression guards for the beadsd update door: an external-ref-only update
(the `prx beads publish` relink) is accepted, and a truly-empty update returns a
typed `bad-request`. Locks in the prx-022t fix. Test-only — no release.
