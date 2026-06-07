---
"@bounded-systems/prx": patch
---

`prx handoff` verbs (enqueue/status/drain/replay) gain an optional `deps` seam
(store / drain / audit-row) defaulting to the real bd/CAS/audit
implementations, so the verbs are unit-testable without a live bd substrate.
Existing call sites pass nothing and are unaffected.
