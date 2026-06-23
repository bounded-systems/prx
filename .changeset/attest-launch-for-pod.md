---
---

Add `room/launch-attest.ts` — the L2 launch-attestation orchestration step:
`podLaunchManifest(pod)` (the pod's resolved door grants = authority held) +
`attestLaunchForPod(pod)` which attests the manifest via the keeper door
(`runKeeperDoorAttestLaunch`) and stores the signed L2 content-addressed
(`storeLaunchAttestation`), returning the `l2LaunchDigest` the box's keeper push
links. Effects are injected seams (offline-testable). The live `playPod` flow
calls this once the keeper door is up, then projects `l2LaunchDigest` into the box
env. No release.
