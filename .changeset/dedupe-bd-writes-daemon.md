---
"@bounded-systems/prx": patch
---

feat(doctor): route dedupe-bd's edge + close WRITES through the daemon (GH-296)

`prx doctor dedupe-bd`'s apply phase rewrote dependency edges and closed
duplicates with host `bd dep remove`/`bd dep add`/`bd update -s closed` against
the per-clone `.beads`. All three now run through the daemon — `prx beads dep
remove|add` (the `dep` kind from #537) and `prx beads update <id> --status closed
--notes` (the close). The close argv switched `-s` → `--status` so it passes to
the typed CLI. A sync runner keeps `runDedupeBd` synchronous; injectable for
tests. Toward removing host bd (prx-82b).
