---
"@bounded-systems/prx": minor
---

Host-beads read router (prx-82b Slice 2b): `resolveBeadsEndpoint` now prefers the
cwd's per-repo POD beadsd socket when that pod is up (`podFor()` →
`<doorDir>/beadsd.sock`), so host `prx beads` reads route to the pod's beadsd
instead of the host-native daemon. Precedence: `PRX_BEADS_SOCKET` override (how
the pod projects its door into a room) → the cwd's pod socket → the host-native
default. `withBeadsClient` only auto-starts a daemon for the host-native socket —
never onto a pod/override socket (which the pod/operator owns). The host-native
daemon stays the fallback (no-pod repos keep working); its full retirement is
Slice 2e, when host bd is removed.
