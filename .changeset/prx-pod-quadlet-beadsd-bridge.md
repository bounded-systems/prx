---
"@bounded-systems/prx": minor
---

Adds the missing pieces to make the per-repo pod's beadsd door reachable from
a macOS host, and gives the whole kube-play pod a production, systemd-Quadlet
lifecycle (prx-8uf2) instead of only its secret-holding rooms:

- New `beadsd-bridge` room (`src/room/beadsd-bridge-room.ts`), added to
  `perRepoPod`: runs the phase-1 loopback door-bridge (`prx door bridge`,
  already shipped) as a pod member, consuming the beadsd door for its
  `$PRX_BEADS_SOCKET` fabric path and publishing a loopback TCP port
  (`9997`) — a macOS host cannot connect a unix socket across the
  podman-machine virtiofs boundary, so this is the only way across
  (`docs/prx/door-bridge.md`).
- `renderPodmanKube` now honors a kube room's `extraArgs` (previously only
  consulted by the secret/run path) — needed for the bridge room's CMD, and
  backward compatible (existing rooms all have empty `extraArgs`).
- New `renderPodmanKubeQuadlet`/`quadletKubeUnitName` (`src/room/podman.ts`):
  a systemd Quadlet `.kube` unit wrapping the whole pod's kube-play manifest,
  the durable counterpart of `playPod`'s ad-hoc `podman kube play -`
  invocation (which has no restart/boot lifecycle today). Emits a loopback
  `PublishPort=` for every non-secret room that declares `tcpPort` — the
  kube YAML itself has no `ports:` field; Podman's own `.kube` Quadlet docs
  confirm `PublishPort=` in the unit merges with the YAML's ports, so this
  is the only place a kube room's TCP port is actually published to the
  host. Render-only (writing the unit/YAML to disk and running
  `systemctl --user daemon-reload` is an operator/deploy step, same
  "render, don't install" contract `renderPodmanQuadlet` already has for
  secret rooms).
