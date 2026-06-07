---
"@bounded-systems/prx": patch
---

feat(fetch): route the GH→bd sync writer's update through the daemon (GH-296)

The fetch writer mirrored GH issue state into bd with host `bd update <id>
--external-ref … --status … --title …` against the per-clone `.beads`. It now
runs `prx beads update …` through the daemon. This also extends the daemon `update`
write contract with `--title` and `--description` (threaded through contract,
daemon dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update`
CLI) — the last update fields the bulk reconcilers needed. A sync runner keeps
`writePage` synchronous; injectable for tests. Toward removing host bd (prx-82b).
