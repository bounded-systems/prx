---
"@bounded-systems/prx": patch
---

`prx delegate assign` now surfaces a clearer failure message when a `GH-\d+`-shaped id fails eligibility — pointing at the bd-native id (`prx beads list`/`prx beads ready`) instead of just bd's raw "no issue found" error. The command itself has no GH-specific parsing; a bd-native id already worked end to end (supply-plan-design-6nd).
