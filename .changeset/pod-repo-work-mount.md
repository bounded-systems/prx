---
"@bounded-systems/prx": minor
---

Mount the repo at `/work` in the rendered pod (prx-u5lx) — the daemon images (`beadsd-box`, `keeperd-box`) set `WorkingDir=/work`, but `renderPodmanKube` only mounted the door tmpfs, so podman/crun couldn't start those containers (`workdir "/work" does not exist`). `PodSpec` gains an optional `repo` (the host repo path, one pod = one repo, resolved at deploy); when set, `renderPodmanKube` emits a `hostPath` volume bind-mounted at `/work` in every room. Without `repo` the manifest is unchanged (back-compat). Live-validated: the real `perRepoPod` (claude-box + beadsd-box + keeperd-box) now plays to **all three rooms Up** on podman — previously keeperd-room failed to start.
