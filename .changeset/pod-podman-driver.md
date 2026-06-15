---
"@bounded-systems/prx": minor
---

Add the podman pod driver — `renderPodmanKube(pod)` renders a `PodSpec` to a `podman kube play` Pod manifest (mirroring the executor's Lima driver: hand-rolled YAML, validated at the seam, behind a `PodDriver` interface). Each room becomes a container sharing one tmpfs `emptyDir` door-fabric volume mounted at `doorDir`; each container's env is the wired-door projection from `podRoomEnv` — so the rendered `claude-room` container carries `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET`, the manifest that actually fires the bd-door gate. The per-room container image is a placeholder pending the `-box` image refs (prx-zj8).
