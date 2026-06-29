---
"@bounded-systems/prx": minor
---

Per-repo pod identity (prx-82b Slice 2a): `prx pod up | down | secrets` now derive
the pod name + door fabric from the cwd's repo (`prx-<slug>` + a per-repo
`<DEFAULT_DOOR_DIR>/<slug>`), via the new `podFor()` resolver over the repo
inventory. So N repos run N isolated pods on N door fabrics — previously the pod
was a singleton (`prx-pod` + one shared door dir), so a second repo's `pod up`
no-op'd and the two pods' `beadsd.sock` would collide. An unregistered cwd falls
back to the legacy singleton (back-compat). The foundation for the host-beads
router (Slice 2b).
