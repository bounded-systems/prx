---
"@bounded-systems/prx": minor
---

Wire the keeperd (git:write) door in the per-repo pod (prx-asr). The pod's `doorEnv` now projects `PRX_KEEPER_DOOR` + `PRX_KEEPER_SOCKET` into a keeperd consumer (claude-room), symmetric to the beadsd door — so the podman driver renders the keeper endpoint for the box for free. Adds `keeperd/endpoint.ts` (`resolveKeeperEndpoint` / `isKeeperDoorMode`) as the client-side reader of that env, mirroring beads' `resolveBeadsEndpoint`/`isBdDoorMode`. Completes the door-fabric wiring for git-writes; adopting the resolver at the keeper call sites (so a boxed prx dials the door) is the follow-on.
