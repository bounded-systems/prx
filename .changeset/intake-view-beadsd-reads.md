---
"@bounded-systems/prx": patch
---

`prx intake view` now reads beads through the beadsd daemon (the "one true source", GH-296 wave 1) instead of the local sync `bd list --all` reader — the bd-record arm routes through `loadAllBeadsViaDaemon` and fails fast if beadsd is unreachable. Direct twin of the `prx plan view` flip.
