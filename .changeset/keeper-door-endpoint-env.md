---
"@bounded-systems/prx": minor
---

Wire the **keeperd door's client-endpoint env** (prx-asr; closes the ADR §4 "keeperd endpoint env" prerequisite in `docs/prx/oci-substrate.md`). The per-repo pod's `podRoomEnv` now projects `PRX_KEEPER_DOOR` + `PRX_KEEPER_SOCKET` into a keeperd consumer (so `claude-room` carries both the beadsd and keeperd doors), and a new `keeperd/endpoint.ts` `resolveKeeperEndpoint` is the canonical reader — the keeper analog of `resolveBeadsEndpoint` (`PRX_KEEPER_SOCKET` for the local door, `PRX_KEEPER_VM` for the Lima daemon). The two halves form a closed contract: the projected env round-trips through the resolver (tested). `PRX_KEEPER_DOOR` is the marker a future keeper-door gate reads, mirroring `PRX_BEADS_DOOR`. Foundation only — the wrapper that turns a resolved endpoint into a live `IsolatedKeeperClient` over the door socket is a follow-on (the transport already exists in `door/transport.ts`).
