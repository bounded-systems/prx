---
"@bounded-systems/prx": minor
---

Wire ghappd into the guest-room pod (prx-36xr complete): ghappd now runs as a room in the per-repo pod, and the App key is a host-backed podman secret — the strongest "better cloud secrets" posture (PEM never in env/argv/a layer).

- **room/ghappd-room.ts** — RoomSpec exposing the `github-app:token` door, pinned
  to the published `ghappd-box` digest, with the App key + id mounted as podman
  secrets (`/run/secrets/ghapp-{key,id}`).
- **room/pod.ts** — `doorEnv` projects the ghappd door as `PRX_GH_APP_DOOR` (the
  endpoint the broker's door backend dials).
- **room/claude-room.ts** — consumes the `github-app:token` door, so the agent
  gets `PRX_GH_APP_DOOR` and leases instead of holding the PEM.
- **room/per-repo-pod.ts** — adds `ghappdRoom` to the pod. (Note: ghappd is not
  repo-specific; a shared/singleton ghappd is a later optimization.)

Completes the chain: `ghappd-room` holds the key → claude-room leases ≤1h scoped
tokens over the door → no App PEM in the agent. Movable by construction (the door
transport resolves unix pod-local or TCP remote). Deploying it requires the
`prx-ghapp-key` + `prx-ghapp-id` podman secrets on the host (see prx-z6ru).
