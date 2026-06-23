---
"@bounded-systems/prx": patch
---

Wire keeper socket readiness poll so `prx pod up` returns a non-null `l2LaunchDigest`.

Three-part fix closing the gap from prx-9yv3/#749:

1. **podman.ts** — `renderPodmanRun` injects `KEEPERD_SOCK=${doorDir}/<basename>` for
   each exposed door, so the keeper daemon writes its socket onto the shared fabric
   (not the in-box default `/run/keeperd.sock`).

2. **pod.ts** — `doorEnv` rebases consumer socket paths to `${doorDir}/<basename>`,
   ensuring the client-side `KEEPERD_SOCK` and `PRX_BEADS_SOCKET` point to the
   shared fabric regardless of the door spec's nominal path.

3. **podman-runtime.ts** — `launchPod` polls for the keeper socket via `waitForSocket`
   (injectable, 500ms interval / 30s timeout), then sets `KEEPERD_SOCK` in the host
   environment before calling `attestLaunchForPod`, and restores or deletes it after.
   Best-effort: a poll timeout or attest failure surfaces as `l2LaunchDigest: null`
   without tearing down the pod.
