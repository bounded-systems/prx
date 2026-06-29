---
"@bounded-systems/prx": patch
---

concierged-box OCI image (prx-8uf2 / prx-9s14) — the buildable image definition for the concierged grant broker. `nix/oci/concierged-box.nix` packages the released prx with an entrypoint that points `PRX_PROVENANCE_MASTER_FILE` at the mounted master secret and runs `prx concierge serve` (no cacert — concierge is local/unix, no network). Exposed as `.#concierged-box` in the flake and given a `concierged-box` job in `publish-oci-boxes.yml` (mirrors ghappd-box: build → push to GHCR → attest). The image is BUILDABLE but produces a working broker only once prx is released past v0.19.0 (the `concierge serve` verb shipped in #853); the actual GHCR publish runs on release. The deployment (prx-9s14) then pins the digest into `concierged-room.ts` + joins the room to the pod.
