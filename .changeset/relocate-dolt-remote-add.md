---
"@bounded-systems/prx": patch
---

Relocate `bd dolt remote add` off host bd (prx-82b Slice 2c.3): the cred-free
remote-add in `prx repo add-dolthub` now runs in an ephemeral beadsd-box
container (`containerRepoRunner`), not the host bd binary. `dolt push` stays on
host for now — it needs DoltHub creds the container lacks, and the sync agent
owns recurring push; relocating the initial push wants a creds-mount design.
