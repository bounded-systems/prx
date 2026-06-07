---
"@bounded-systems/prx": patch
---

Additive testability seams (behavior-preserving): `readSubstrateWatermark` and
`defaultSubstrateRefresher` in the fetch freshness-gate take an injectable
reader/fetch (default to the real bd/gh implementations) so their outcomes are
unit-testable. Production call sites pass nothing.
