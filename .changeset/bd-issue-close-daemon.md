---
"@bounded-systems/prx": patch
---

feat(tools): route the bd close primitive through the daemon (GH-296)

`execBdIssueClose` — the single `bd close` wrapper behind `submit postmerge`, the
gh adapter's `bulkClose`, and `intake merge`'s dup close — spawned host `bd close
<id>` against the per-clone `.beads`. It now spawns `prx beads close <id>
[--reason]`, which the daemon maps to `bd update --status closed --notes`. One
spawn-target change migrates all three callers' close path off host bd at once.
Toward removing host bd (prx-82b).
