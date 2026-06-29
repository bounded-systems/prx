---
"@bounded-systems/prx": minor
---

Add `prx services series` — effort/token series showing completion rate by
model × spend tier.

Reveals the non-monotonic relationship between spend and outcome (higher spend
does not monotonically improve completion rate past a model-specific peak).
Refactors the shared work-unit loading into a private `buildWuidOutcomes`
helper used by both the diamond and series projectors.
