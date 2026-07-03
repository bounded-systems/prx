---
"@bounded-systems/prx": patch
---

Mount the door fabric at a host-agnostic in-container path (`guestDoorDir`,
default `/run/prx/doors`) instead of the real host `doorDir`. Previously
every room mounted the fabric at the identical host path (e.g.
`/Users/bobby/.local/run/prx/doors`), letting a guest fingerprint the host's
OS, username, and home layout from its own mount table / env vars even
though the doors themselves are otherwise access-controlled. `doorDir` now
means the host-side source only; all in-container references (kube
`mountPath`, `Volume=`/`--volume` destinations, `podRoomEnv`'s projected
env, `--socket` args) resolve through `guestDoorDir`.
