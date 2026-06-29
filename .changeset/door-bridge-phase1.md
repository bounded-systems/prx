---
"@bounded-systems/prx": minor
---

Door-bridge phase 1 — `prx door bridge` (prx-8uf2): a `127.0.0.1`-only TCP→unix forwarder that gives a host-side caller a way to reach a door (ghappd/keeperd/beadsd) that otherwise only listens on a unix socket. Frame-transparent (forwards bytes, never parses door frames), loopback-hardcoded (`BRIDGE_BIND_ADDRESS`, never `0.0.0.0`), and explicitly opt-in (you run the verb), with a loud dev-only caveat at startup — the edge is UNAUTHENTICATED and widens the door from the socket's owner to all local users. Phase 2 adds the signed-grant gate (reusing keymaker/provenance, per-lease grants) in front of this forward. New: `src/door/bridge.ts` (`runLoopbackBridge`) + `src/door/bridge-verb.ts`, both tested.
