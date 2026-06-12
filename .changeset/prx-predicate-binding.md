---
"@bounded-systems/prx": minor
---

Add the predicate binding-semantics precursor to `TransitionContract`: a per-member binding tag (`property` | `event`), a `RequiredPredicate` bundle member, and an optional `requiredPredicates` array on `transitionContractSchema`. Backward-compatible — when the field is absent, `requiredPredicatesOf()` projects the singular `requiredArtifact`/`requiredStatus` pair to a one-member property-bound bundle, so the shipped contracts and their guards are unchanged. This is the type-level seam both the intake-to-plan lifecycle contracts and the merge-verdict bundle read through; the bundle-weighing verdict and the capability-footprint → required-predicate mapping are follow-ups.
