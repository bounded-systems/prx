---
---

Add `launchPod` (`room/podman-runtime.ts`): bring a pod up via `playPod` (the
keeper door comes up last), then `attestLaunchForPod` attests + stores the L2 —
the keeper daemon remembers it so the box's writes auto-link (no box-env injection).
Best-effort attest: a failure (e.g. no keeper door) surfaces as `l2LaunchDigest:
null` but never tears the pod down; the submit gate enforces the chain downstream.
This is the home for the launch-attestation hook (prx-zj8 wires `playPod` into the
live flow). Also re-pins `keeperd-room` to the auto-link door-keeper image. No release.
