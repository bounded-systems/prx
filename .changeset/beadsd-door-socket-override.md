---
"@bounded-systems/prx": patch
---

Fix the beadsd door not landing on the shared pod fabric (prx-asr). The rootless
doorDir migration mounts the host fabric at `doorDir` inside each container, but
non-secret rooms ran their daemon's image-default `--socket` (e.g. beadsd-box's
`/run/prx/doors/beadsd.sock`) — off-fabric, so consumers (claude-room) couldn't
reach beadsd. `renderPodmanKube` now overrides `--socket ${doorDir}/<sock>` for
each open exposed door, mirroring the secret-room path; sealed doors (claude-room
`control`) and non-daemon occupants get nothing.
