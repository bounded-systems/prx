---
"@bounded-systems/prx": minor
---

Retire the host dolt-server lifecycle (prx-82b Slice 2e.3). The pod's dolt-box is
the dolt server now (`prx pod up`), so the host-server start/stop are gone:
`prx dolt start` is routed to the typed `dolt-stub` (no host server start; the
`dolt-start` command + `dolt/start.ts` are deleted), and `prx beads hydrate` no
longer runs `bd dolt stop` (the host-native daemon that auto-started a host dolt
server was retired in 2e.4, and hydrate's clone runs in an ephemeral container).
`beads/hydrate.ts` + `dolt/start.ts` leave the door-boundary `HOST_ONLY_BD` list
(neither spawns bd). `prx dolt status` + `dolt/status.ts` stay (the latter is
shared with `create_database`).
