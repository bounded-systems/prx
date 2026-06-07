---
"@bounded-systems/prx": patch
---

feat(triage): route drift-fix WRITES through the daemon (GH-296 prx-ebo)

`triage drift-fix`'s apply phase mutated beads with host `bd update`/`bd reopen`
against the per-clone `.beads` — the broken store GH-296 is retiring. Its two
write seams now go through the daemon (the trusted single writer):

- type/priority fix → `updateBeadViaDaemon(id, { issueType, priority })`
- status fix → `reopenBeadViaDaemon(id)`

Both default to the beadsd helpers and are injectable (`deps.updateBead` /
`deps.reopenBead`) for tests. The helpers throw on a non-ok daemon verdict
(vs `execBd`'s exit code), so a failed write records `exitCode: 1` + the daemon's
message in the audit row (partial-write accounting unchanged). The aggregate read
already routes through the daemon via the BeadsCache loader (prx-fda).

A step toward removing host bd (prx-82b): the remaining bulk write reconcilers
(promote, intake-mirror/merge/comment, close-stale, dedupe deps, adapters
write-back) are the next sites.
