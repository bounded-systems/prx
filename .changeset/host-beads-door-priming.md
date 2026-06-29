---
"@bounded-systems/prx": minor
---

Host-shell read routing (prx-82b Slice 2e.1): `primeHostBeadsDoor` — on a host
shell in a repo whose pod is up, prx now points `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET`
at that pod's beadsd socket at startup, so the door-gated bd READ sites
(`bdDoorGate` / `bdCommandRunner`) route to the pod instead of spawning host bd.
No-op in a pod/room profile (the pod already projects these) or when no pod is up
(the host-native daemon stays the fallback until 2e.4). Reuses `podFor` (2a) +
the pod-socket probe (2b); env writes go through `@bounded-systems/env` `setEnv`.
