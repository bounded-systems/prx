---
"@bounded-systems/prx": minor
---

Repoint the ready queue off `bd ready` onto Front Desk (GH-1010). The next-work
picker (`queryBdReady`) and the beadsd `ready` door now read the WSJF-ranked
ready/blocked queue from the verified Front Desk scheduler (via a spawned `fds
graph`, zero GitHub API) instead of shelling `bd ready`. Front Desk is
GH-canonical, so items map to synthetic `GH-<n>` bd ids with the issue URL as
`external_ref`. Default source is `frontdesk`; `PRX_READY_SOURCE=bd` falls back
to `bd ready`. The `dep`/`children` door stays on bd for now — its epic identity
is bd-bead-id-based and moves with `bd list` (GH-1011).
