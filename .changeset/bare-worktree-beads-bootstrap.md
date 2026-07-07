---
"@bounded-systems/prx": patch
---

Fix `prx repo bootstrap`/`prx repo add-dolthub` for bare-repo + linked-worktree repos: the ephemeral container now mounts the repo's git-common-dir alongside the worktree (fixing "not a git repository" failures in `bd init`), the missing `BD_BOOTSTRAP_AUTO_PUSH_DISABLE*` events are registered in the event catalog, and `.beads/` classification falls back to the git-common-dir where `bd init` actually places embedded-mode workspaces for this layout.
