---
"@bounded-systems/prx": minor
---

Relocate the bd setup-lifecycle ops off host bd (prx-82b Slice 2c.2): `bd init`,
`bd migrate`, and the bootstrap `bd config set` now run in an ephemeral beadsd-box
container (`containerBdRunner` → `runBdLifecycle`) by default, not the host `bd`
binary. The host-bd primitives (`defaultBdInitRunner`/`defaultBdMigrateRunner`)
stay as the injectable seam for tests. Also fixes the runner to set `HOME=/tmp`
(under `--userns keep-id` the image's `/home/prx` isn't writable by the remapped
uid, so dolt's global-config mkdir would panic — verified live: `bd init` now
succeeds in-container with `.beads` host-owned). `prx repo bootstrap` / `migrate`
no longer shell to host bd.
