---
"@bounded-systems/prx": minor
---

Pod model: non-door backing services (prx-asr data layer, Phase 3). `PodSpec`
gains a `services` array (`PodServiceSchema`: name/image/dataVolume/env/args, no
doors) for co-resident infrastructure like dolt-box. `renderPodmanKube` renders
each service as a plain container with a `persistentVolumeClaim` named volume
(podman maps it to a named volume, auto-created and preserved across `kube
down`) — no door fabric mount, no `--socket`. The per-repo pod now ships the
`dolt` backing service (the dolt SQL server beadsd connects to). Wiring beadsd
to it lands next.
