---
"@bounded-systems/prx": patch
---

Read the aggregate/targeted work-item loaders from Front Desk directly, dropping
the beadsd daemon hop (GH-1012, toward fully removing beads). `loadAllBeadsViaCli`,
`loadAllBeadsViaDaemon`, and `showBeadViaDaemon` now call `frontDeskBeadsRaw`/
`frontDeskBeadRaw` instead of round-tripping through the daemon (which, since
GH-1017, already served Front Desk). Behavior-preserving — the records are the
same GH-canonical `BeadsRecord[]` consumers already received; only the daemon
round-trip is removed. This leaves the daemon with no read callers, clearing the
way to delete beadsd and the bd dependency.
