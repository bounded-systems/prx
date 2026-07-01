---
"@bounded-systems/prx": patch
---

`buildOrgHarnessSettings()` now wires `.claude/ensure-beads.sh` ahead of `inject-org-context.sh` in the generated `SessionStart` hooks — a host-side bridge for the retired beadsd auto-start (prx-82b Slice 2e.4) so local sessions can reach `prx beads` without a manual `prx beads serve`.
