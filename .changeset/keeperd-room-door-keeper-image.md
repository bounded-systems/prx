---
---

Pin `keeperd-room` to the canonical door-keeper OCI image (by digest,
`ghcr.io/bounded-systems/door-keeper/keeperd@sha256:…`) instead of the local
`keeperd-box` placeholder — exposed as `KEEPERD_ROOM_IMAGE`. This activates the
door-keeper path (Phase B): the keeper pod now runs door-keeper's model-A daemon
(import-and-push + L3), which prx verifies at the submit-publish gate. No release.
