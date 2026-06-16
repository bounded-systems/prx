---
"@bounded-systems/prx": patch
---

`renderPodmanQuadlet` projects a secret-holding room (prx-b44y) to a systemd podman **quadlet** (`.container`) unit — the durable production counterpart of `renderPodmanRun`'s ad-hoc argv. Same wiring (host-backed `Secret=…,target=…`, the shared `/run/prx/doors` fabric with a `:z` SELinux relabel, the repo `/work` mount, the wired-door env) plus claude-box's capability hardening floor (`NoNewPrivileges`, `DropCapability=all`, pid/memory caps). Egress stays at the podman default — unlike claude-box's socket-only keeper, prx's keeperd holds the push credential and must reach the git remote. Rendered from the `PodSpec`, so it can't drift from the door wiring.
