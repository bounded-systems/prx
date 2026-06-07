---
"@bounded-systems/prx": patch
---

Additive testability seams (behavior-preserving): `defaultProbe` and
`bdDelegatingSpawn` in dolt/start take an injectable spawn (default real), and
`defaultReadLedger`/`defaultWriteLedger` are now exported, so the bd-backed
start defaults are unit-testable. Production call sites pass nothing.
