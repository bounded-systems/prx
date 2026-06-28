---
"@bounded-systems/prx": patch
---

Add `org.opencontainers.image.source` to the beadsd-box and ghappd-box OCI images so each ghcr package is deterministically linked to `bounded-systems/prx` (and carries provenance). This is the documented, explicit way to tie a package to a repo for Actions push access — rather than relying on GitHub's implicit auto-link-on-create, which left `beadsd-box` an unowned orphan (`repository: null`, private → 403 on publish).
