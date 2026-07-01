---
"@bounded-systems/prx": patch
---

`primeHostBeadsDoor` no longer primes toward the legacy singleton door fallback (`~/.local/run/prx/doors/beadsd.sock`, `podFor`'s back-compat bucket for any repo not registered under its exact commonDir) — only toward a door scoped to the cwd's own resolved per-repo identity. The singleton is a well-known, shared path any unregistered repo's host shell can reach; priming toward it was ambient authority — a process for repo A could silently reach whatever repo B's door happened to be serving, with the only guard being the destination daemon's own best-effort `foreignWorkspaceId` heuristic, not a client-side capability check. An unregistered cwd now falls through to `resolveBeadsEndpoint`'s own git-common-dir derivation instead, which is self-scoped by construction (a caller can only ever derive its own commonDir's path). Registered repos with a live per-repo door are unaffected.
