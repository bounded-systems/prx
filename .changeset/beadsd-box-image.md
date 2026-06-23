---
"@bounded-systems/prx": patch
---

Pin beadsd-box OCI image digest in `beadsd-room` (prx-634). Image is built via
`nix dockerTools.streamLayeredImage` (prx, bd, dolt, git, cacert) and pushed to
`ghcr.io/bounded-systems/prx/beadsd-box`; the digest reference replaces the
placeholder `"beadsd-box"` string. Adds `publish-oci-boxes.yml` CI workflow that
rebuilds and pushes on every `v*` tag.
