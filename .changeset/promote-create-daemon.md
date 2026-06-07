---
"@bounded-systems/prx": patch
---

feat(triage): route `triage promote`'s bd create through the daemon (GH-296)

`prx triage promote` created bd records for GH issues with host `bd create
--silent --external-ref … --type … -p … --title …` against the per-clone
`.beads`. It now runs `prx beads create --external-ref … --type … --priority …
--title …` through the daemon and parses the created id from the JSON echo (no
`--silent`; `-p` → `--priority`). The GH pointer-comment leg stays on gh. A sync
runner keeps `runTriagePromote` synchronous; injectable for tests. Toward
removing host bd (prx-82b).
