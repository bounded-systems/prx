---
"@bounded-systems/prx": patch
---

feat(delegate): route repair-assignees' assign WRITE through the daemon (GH-296)

`prx delegate repair-assignees --apply` rewrote bd assignees with host `bd assign
<id> <to>` against the per-clone `.beads`. It now runs `prx beads update <id>
--assignee <to>` through the daemon (`bd assign` == `update --assignee`). A sync
runner keeps `runRepairAssignees` synchronous; injectable for tests. The matched
`bd list --assignee` read stays for the reads sweep. Toward removing host bd (prx-82b).
