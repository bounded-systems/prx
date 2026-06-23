---
"@bounded-systems/prx": minor
---

Add `prx pod up` verb: launches the per-repo pod (claude-room + beadsd-room + keeperd-room) via `launchPod`, attests the launch (best-effort L2), and returns `{ pod, containers, l2LaunchDigest }`. Rootless `doorDir` (`$XDG_RUNTIME_DIR/prx/doors` or `~/.local/run/prx/doors`) so no sudo is required on macOS/Linux. Injected into the verb registry and routed via `cli.ts`.
