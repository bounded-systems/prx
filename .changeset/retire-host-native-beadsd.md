---
"@bounded-systems/prx": minor
---

Retire the host-native beadsd daemon + its auto-start (prx-82b Slice 2e.4, full
cutover). `prx` no longer falls back to — or auto-starts — a host-native beadsd:
`resolveBeadsEndpoint` resolves `PRX_BEADS_SOCKET` → the cwd's pod socket, and
when no pod is up (and no override) it THROWS `BeadsUnavailableError` with a
"run `prx pod up`" hint. `withBeadsClient` never spawns a daemon (the pod owns
beadsd; it runs `prx beads serve` in-box). Removed: `ensureLocalBeadsd`,
`isHostNativeSocket`, `DEFAULT_LOCAL_BEADS_SOCKET`. Host beads is pod-only now
(less host is better). BREAKING for host shells with no pod up — start one with
`prx pod up`. (`prx beads serve` + `resolveLocalBeadsCwd` stay — the pod uses them.)
