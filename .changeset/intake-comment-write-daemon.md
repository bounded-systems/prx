---
"@bounded-systems/prx": patch
---

feat(intake): route intake-comment's bd note WRITE through the daemon (GH-296)

`prx intake comment` on a bd-shaped id appended its note with host `bd update <id>
--notes …` against the per-clone `.beads`. It now runs `prx beads update <id>
--notes …` through the daemon (using the `update --notes` field added in #528). A
sync subprocess keeps `runIntakeComment` synchronous; runner injectable for tests.
Toward removing host bd (prx-82b).
