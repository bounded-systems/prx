---
"@bounded-systems/prx": minor
---

Auto-repin room images (prx-hfgg, the prx-zee7 release-chain wart): publish-oci-boxes gains a `repin` job that, after the boxes rebuild+push (e.g. on a release tag), bumps each room's pinned `<box>@sha256:…` to the freshly-built digest and opens a PR (via the prx-forge App token). Removes the manual repin hop that caused the ghappd door's mis-ordered deploys. New: src/room/repin.ts (pure `repinImage` + `BOX_PINS`, tested) + scripts/repin-boxes.ts (skopeo inspect → repin → changeset).
