---
"@bounded-systems/prx": patch
---

feat(intake): route intake-merge's pointer-note WRITE through the daemon (GH-296)

`prx intake merge`'s bd↔bd arm appended the merge pointer note with host `bd
update <id> --notes …` against the per-clone `.beads`. It now runs `prx beads
update <id> --notes …` through the daemon. A sync runner keeps `runIntakeMerge`
synchronous; injectable for tests. The dup close still flows through
`execBdIssueClose` (migrated separately at the close primitive). Toward removing
host bd (prx-82b).
