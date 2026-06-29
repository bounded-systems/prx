---
"@bounded-systems/prx": minor
---

Move `prx beads hydrate`'s `dolt clone` off host dolt (prx-82b Slice 2d):
`containerDoltClone` runs the clone in an ephemeral beadsd-box container with
DoltHub creds on the room-secret rail (`prx-dolt-creds`) — the dest's parent is
bound at `/work` and dolt clones into it (host-owned via keep-id), then hydrate's
host-side rename promotes the mirror. Shares the credentialed-dolt wrapper with
`dolt push` (2c.5). No host `dolt` binary in the hydrate clone path. (The
`bd dolt stop` host-cleanup in hydrate stops a host process — moot once host bd
is removed in 2e; left for then.)
