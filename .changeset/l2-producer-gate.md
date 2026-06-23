---
---

Finish the L2 producer + enforcement layers (capability chain):
- `runKeeperDoorAttestLaunch` — produce a signed L2 launch via the keeper door
  (door-kit `attestLaunch`, door-kit `^0.5.0`); the launch key never leaves the daemon.
- `runKeeperDoorPush` threads `l2LaunchDigest` so the L3 write links back to the launch.
- `resolveLauncherTrustKey` (`PRX_LAUNCH_PUBKEY`) — the operator-supplied launcher key.
- `submit publish` gate: **opt-in capability-chain enforcement** — when a launcher
  key is configured, the door L3 must link to a verifiable L2 launch
  (`verifyLaunchChain`), fail closed; otherwise behaviour is unchanged.
- Re-pin `keeperd-room` to the door-keeper image that links L2 into L3.
No release. (Live launch-flow producer + CAS distribution are the remaining capstone.)
