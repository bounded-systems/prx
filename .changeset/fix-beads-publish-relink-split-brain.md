---
"@bounded-systems/prx": patch
---

Fix `prx beads publish` relink split-brain (prx-022t): switch the default bead reader in `publishOne` from direct `execBd` (reads the worktree's `.beads`) to `loadAllBeadsViaCli` (daemon-backed, reads the canonical `~/.local/state/prx/beads`). When the two databases diverge the daemon's `bd update --external-ref` step was failing with "record not found", leaving the GH issue created but the bead unlinked. Using the daemon for both read and write ensures consistency and pre-warms the daemon before the write-back step.
