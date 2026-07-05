---
"@bounded-systems/prx": minor
---

`prx pod up`: single-writer preflight guard for backing-service data volumes. Before bringing a pod up, `playPod` now refuses (with a loud, named error) if a backing service's data volume — e.g. dolt-box's `prx-dolt-data`, now owned by the claude-box Quadlet `dolt` door backend — is already held by an external container. Enforces the one-writer-per-store invariant (I5) from the prx side; mirrors the claude-box `dolt.container` guard.
