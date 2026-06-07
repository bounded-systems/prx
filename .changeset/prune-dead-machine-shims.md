---
"@bounded-systems/prx": patch
---

Remove dead code (knip): the unused `machine/{index,events,state,derive-phase,invariants}.ts` re-export shims and the never-wired `pr-state/personal_sprintx.ts`. The personal-sprint metric/goal model is captured as a backlog idea in #438 for a future, properly-wired implementation.
