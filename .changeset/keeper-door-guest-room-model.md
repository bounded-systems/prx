---
---

A1 of the prx→guest-room convergence: add `@bounded-systems/guest-room` as a prx
dependency (github dep until it publishes to JSR) and describe the keeper door
through guest-room's capability model — a `DoorCatalog` preset + a rulebook
rendered by guest-room's `resolveDoor`/`grantedDoorLines`/`deniedDoorSection`.
First real dependency edge from prx onto the flagship runtime. Additive: the
keeperd transport is unchanged; the keeper endpoint env stays sourced from
`keeperd/endpoint.ts`. No public API or behavior change, no release.
