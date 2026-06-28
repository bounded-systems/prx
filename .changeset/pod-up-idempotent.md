---
"@bounded-systems/prx": patch
---

`prx pod up` is now idempotent (prx-asr). Re-running it against an
already-running pod previously failed with `podman kube play … "<pod>" is in
use: pod already exists` (exit 125). `playPod` now probes `podman pod exists
<name>` first and returns a no-op result when the pod is up — non-destructive
(healthy daemons aren't restarted); run `prx pod down` first to recreate.
