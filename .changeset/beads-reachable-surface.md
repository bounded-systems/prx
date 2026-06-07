---
"@bounded-systems/prx": patch
---

`prx beads ready|list|show` is now the reachable beads surface from **any shell**: with no `--vm` it routes through the local daemon via `withBeadsClient` (auto-started), instead of requiring `--vm`/`PRX_BEADS_VM`. `--vm <name>` still targets an in-VM daemon explicitly. This gives interactive agents and humans a working beads path even where raw `bd` is unreachable in a worktree (`issue_prefix config is missing`). The `/prx` orchestrator command now points at `prx beads show` for this reason.
