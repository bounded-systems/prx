---
"@bounded-systems/prx": patch
---

feat(intake): route `prx intake`'s bd create through the daemon (GH-296)

`prx intake` created its bd record with host `bd create --silent --type … --title
…` against the per-clone `.beads`. It now runs `prx beads create --type … --title
… [--description]` through the daemon and parses the created id from the JSON echo
(no `--silent`). The `--to gh` publish leg is threaded the same sync runner so its
write-back also routes through the daemon. Toward removing host bd (prx-82b).
