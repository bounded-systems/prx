---
"@bounded-systems/prx": minor
---

Add `prx pod down` + `prx pod up --recreate` so the deploy lifecycle is fully prx-owned (no raw `podman pod rm`). `pod down` tears the pod down (kube down + rm secret-room containers — the counterpart `playPod`'s no-op message already pointed at); `pod up --recreate` tears down then launches, to apply a changed spec (e.g. a new image digest). Both routed in cli.ts + covered by the box-verbs-routed guard.
