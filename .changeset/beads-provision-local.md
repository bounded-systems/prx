---
"@bounded-systems/prx": patch
---

Add `prx beads provision --origin <owner/repo> [--cwd <path>]` — the host twin of `prx lima provision-beads`. It dolt-clones the canonical beads into the well-known `~/.local/state/prx/beads` (writing the server-mode `metadata.json` bd needs), so the local daemon serves one healthy beads from every worktree. With this provisioned, `resolveLocalBeadsCwd` auto-selects it and `prx beads ready|list|show` returns real data from any shell — no per-worktree `bd` and no `--vm`.
