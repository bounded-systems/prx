---
"@bounded-systems/prx": patch
---

feat(adapters): route the notion adapter's writes through the daemon (GH-296)

`NotionDomainAdapter` wrote bd with host `bd update <id> --metadata
external_refs.notion=<pageId>` (the mirror write-back) and `bd update <id>
--status closed` (bulkClose) against the per-clone `.beads`. Both now run
`prx beads update …` through the daemon. This also adds `--metadata` to the daemon
`update` write contract (threaded through contract, dispatch, the
`updateBeadViaDaemon` helper, and the `prx beads update` CLI). A sync runner
replaces the `bdExec` getter; injectable for tests. This was the last bd WRITE
reconciler on host bd — toward removing host bd (prx-82b).
