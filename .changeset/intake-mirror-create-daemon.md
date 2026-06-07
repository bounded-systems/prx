---
"@bounded-systems/prx": patch
---

feat(intake): route intake-mirror's bd create through the daemon (GH-296)

`prx intake mirror` created the bd record for a GH issue with host `bd create
--silent --external-ref … --title …` against the per-clone `.beads`. It now runs
`prx beads create --type task --external-ref … --title …` through the daemon and
parses the created record's id from the JSON echo (no `--silent` id-line needed).
Also exposes `--external-ref` / `--silent` on the `prx beads create` CLI (the
contract already carried them). A sync runner keeps `runIntakeMirror`
synchronous; injectable for tests. Toward removing host bd (prx-82b).
