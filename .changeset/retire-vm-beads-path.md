---
"@bounded-systems/prx": minor
---

Retire the in-VM beads read path and the last Lima daemon modules (prx-zj8 — the
podman pod is the substrate). Drops `--vm`/`--vm-socket`/`--host-socket` +
`PRX_BEADS_VM` from `prx beads read|write|prime`; `withBeadsClient` resolves a
local endpoint only (the host-native daemon or the pod's door socket via
`PRX_BEADS_SOCKET`), and the cross-repo affinity guards are now unconditional.
Deletes `beadsd/lima.ts`, `lima/channel.ts`, `lima/lifecycle.ts`. Final
Lima-daemon-retirement PR: only `prx lima provision-builder` (the nix builder)
remains on Lima.
