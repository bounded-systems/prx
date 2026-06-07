---
"@bounded-systems/prx": patch
---

`prx plan search` and `prx intake search` now read beads through the beadsd daemon (GH-296): the case-insensitive title filter (`searchBd`) is refactored into a pure function over records, and the verbs load via `loadAllBeadsViaDaemon` (search is a legitimate scout-shaped aggregate read). No local `bd` in the search path. The local-only "bd list exited non-zero but emitted a valid array" tolerance no longer applies at the verb level — the daemon (server-mode dolt) owns the parse and that post-listing condition can't occur; bd-unreachable still degrades to GH-only.
