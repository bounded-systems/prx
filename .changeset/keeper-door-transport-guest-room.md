---
---

A2 of the prx→guest-room convergence: route the keeper door over the published
guest-room door protocol instead of prx's bespoke length-prefixed framing. The
client transport now dials via guest-room `call(endpoint, "import-and-push", …)`
(unix path or `host:port`, needing guest-room ≥0.2.0 for TCP), and `runKeeperServe`
serves via guest-room `createDoorHandlers` + `Bun.listen`, returning a
`{ close(), closed }` handle. The keeper wire contract (`keeperd/contract.ts`)
and the signed import-and-push behaviour are unchanged; the bespoke framed
transport stays for beadsd/session-host. Bumps the guest-room dep to ^0.2.0.
Internal wire only — no public CLI/API change, no release.
