---
"@bounded-systems/prx": minor
---

Retire `prx keeper up | down` (the in-VM keeperd lifecycle — superseded by the
pod's keeperd-room, prx-zj8) and delete the now-dead Lima daemon modules
(`keeperd/lima-keeperd.ts`, `keeperd/lima-transport.ts`, `ghappd/lima-ghappd.ts`).
Keeps `prx keeper push | branch | commit | serve`. Second of the
Lima-daemon-retirement PRs.
