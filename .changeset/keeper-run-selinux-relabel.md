---
"@bounded-systems/prx": patch
---

`renderPodmanRun` now emits a `:z` (shared) SELinux relabel on the door-fabric and repo bind mounts (prx-3urm). On an SELinux-enforcing host (e.g. a Fedora podman machine) the bare `--volume src:dst` left the door dir labeled `var_run_t`, so the keeper hit `EACCES` creating its socket; `:z` relabels it to `container_file_t`. It's `:z` (shared — the door fabric and repo are shared with the kube pod's containers), not `:Z` (private), and a no-op on non-SELinux hosts. Live-validated on the host: with a rootless-owned `/run/prx/doors`, the rendered argv brings the keeper up listening on the shared fabric with no manual `chcon`. (Note: rootless `:z` can only relabel a dir the runtime user owns — provisioning `/run/prx/doors` with the right ownership is the remaining prx-3urm scope, tracked separately.)
