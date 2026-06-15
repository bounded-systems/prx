---
"@bounded-systems/prx": minor
---

Add `withKeeperClient` (`keeperd/client-factory.ts`) — the door-dialing seam that `keeperd/endpoint.ts` deferred (prx-asr). It assembles `resolveKeeperEndpoint` → `resolveFramedTransport` → `IsolatedKeeperClient`, so a caller gets a live keeper-door client from the env the per-repo pod projects (`PRX_KEEPER_SOCKET`), unix-socket or `host:port`. Mirrors beadsd's `withBeadsClient`; foundation only — it builds the client but does not yet route the pipeline's git-writes through it (the caller still injects the client into `runKeeperRemote`).
