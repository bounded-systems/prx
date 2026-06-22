---
---

Phase C of the prx→guest-room/SDK convergence: the keeper **door push**
(`runKeeperDoorPush`, the live submit-publish path) now consumes the published
`@bounded-systems/door-kit` keeper client (`importAndPush`) instead of prx's
bespoke `IsolatedKeeperClient`/transport. prx's keeper door env is aligned to
door-kit's convention (`KEEPERD_SOCK`, projected by the pod) so the published
client is consumed as-is. Model A is preserved (host bundles; daemon imports +
signed-pushes) and the daemon stays prx's guest-room-protocol server. The legacy
`runKeeperRemote` path is unchanged. No release.
