---
"@bounded-systems/prx": patch
---

feat(triage): route promote-children's dep-edge WRITE through the daemon (GH-296)

`triage promote-children` wired parent-child / blocks edges with host `bd dep add
--type <t> <from> <to>` against the per-clone `.beads`. It now runs `prx beads dep
add …` through the daemon (the `dep` write kind added in #537). A sync subprocess
keeps `runTriagePromoteChildren` synchronous; runner injectable for tests. Toward
removing host bd (prx-82b).
