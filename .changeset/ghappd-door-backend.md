---
"@bounded-systems/prx": minor
---

ghappd Phase 2: the broker's door backend. When `PRX_GH_APP_DOOR` is set, the agent leases a short-lived installation token from ghappd over the door transport instead of minting from a local PEM — so the agent holds no App key, only a reference to the door.

- **broker.ts** — extracted `cachingBroker(fetchToken, opts)` (the cache / expiry-refresh / concurrency-dedupe), now shared by both token sources; `createBroker` delegates to it (behavior unchanged).
- **door-source.ts** — `createDoorBroker({ endpoint, repositories?, permissions?, ... })`: leases via `IsolatedGhappdClient` over `resolveFramedTransport(endpoint)`, fail-closed on an error reply, cached like the local broker.
- **apply.ts** — precedence is now `GH_TOKEN`/`GITHUB_TOKEN` (CI) > **ghappd door** (`PRX_GH_APP_DOOR`) > local App key (`PRX_GH_APP_*`) > personal `gh`. New result `source: "door"`.

This is the security posture from GHAPPD.md: the long-lived App key lives behind
the door, the agent receives only a ≤1h lease. Running the door (`ghapp serve`)
is the remaining Phase 1 wiring (via VerbSpec).
