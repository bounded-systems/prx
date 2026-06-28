---
"@bounded-systems/prx": patch
---

beadsd-box connects to the external dolt-box (prx-asr data layer, Phase 4). The
beadsd-box entrypoint now builds a box-local `.beads` (copied from the shared
`/work/.beads`, with the local `dolt/` clone dropped and `dolt-server.port` set
to dolt-box's 3307) and serves `--cwd /beadsd` — so bd connects to the standalone
dolt-box over the pod netns instead of spawning its own dolt on the repo's
`/work/.beads` (which is shared with host bd). Rebuilt off current prx + bd 1.0.3
(fixes the stale `wisps` schema) and re-pinned `BEADSD_ROOM_IMAGE`. Verified live:
new beadsd-box + dolt-box on the FOD-seeded data → `bd ready` returns real beads
rows, `/work/.beads` untouched.
