---
"@bounded-systems/prx": patch
---

Fix `prx repo add` collision when two registered repos share a name across
different owners (e.g. `github.com/a/deploy` and `github.com/b/deploy`) — the
mainx worktree path is now org-qualified (`wtRoot/io.<host>/<owner>/<name>/mainx`),
mirroring the bare-repo path convention instead of colliding on name alone.
The worktree root also moves from `~/.local/state/wt/worktrees` back to
`~/.local/state/git/worktrees` (the pre-worktrunk convention; worktrunk is
retired). `defaultRootsForHome()`'s `--everywhere` scan now also covers
`$HOME` itself at depth 1, and no longer crashes on unreadable directories
(e.g. `~/.Trash`) encountered during the walk.
