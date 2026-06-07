---
"@bounded-systems/prx": patch
---

The local beadsd auto-start now serves a **canonical** beads clone decoupled from the current worktree (GH-296), so `prx beads` returns the same healthy beads from any shell instead of whichever clone's (possibly broken) `.beads` is underfoot. `resolveLocalBeadsCwd` resolves it: `PRX_BEADS_CWD` (explicit override) → the well-known `~/.local/state/prx/beads` clone when present → `findRepoRoot()` (back-compat fallback).
