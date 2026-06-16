---
"@bounded-systems/prx": minor
---

Add the **podman runtime** (`room/podman-runtime.ts`) — `playPod`/`downPod`, the prx-asr capstone that actually runs a pod. They pipe `renderPodmanKube(pod)` into `podman kube play -` / `podman kube down -` through the `@bounded-systems/proc` `defaultRunner` seam (injected runner ⇒ fully offline unit-tested; a non-zero exit becomes a typed `PodmanRuntimeError`). The rendered manifest already declares the shared `emptyDir{ medium: Memory }` door volume, so `podman kube play` provisions the door fabric — no separate volume step. Live-validated on podman: a single-room `beadsd-box` pod plays to a Running pod with the door volume and `downPod` removes it. Foundation toward the full per-repo pod — playing `perRepoPod` end-to-end still waits on the `claude-box` image (prx-d4o).
