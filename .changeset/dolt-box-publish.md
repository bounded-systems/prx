---
"@bounded-systems/prx": patch
---

Publish the dolt-box backing-service image to GHCR (prx-asr data layer). Adds a
dolt-box job to publish-oci-boxes.yml (mirrors beadsd-box) and pins the digest
as `DOLT_BOX_IMAGE` (packages/prx/src/room/dolt-service.ts). dolt-box is the
standalone dolt SQL server (port 3307, named volume) the per-repo pod's beadsd
connects to ("connect-to-external-dolt"). Image-only; wired into the pod in a
follow-up.
