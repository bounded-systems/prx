---
"@bounded-systems/prx": patch
---

Fix `prx repo convert-to-bare`: when the source repo already had
`extensions.worktreeConfig` enabled before conversion (e.g. from prior
`git worktree` use), the newly-created worktree could permanently inherit
`core.bare=true` from the bare's shared config, breaking `git status` and
other work-tree-scoped commands with "this operation must be run in a work
tree" even though `git worktree list` showed it correctly. The per-worktree
`core.bare=false` override is now set explicitly for the main worktree and
every repaired sibling, regardless of whether the extension was already on.

Add `prx repo list --list-origins` — prints each discovered repo's `origin`
remote URL, deduped and sorted, for scripting against every repo's upstream
in one pass.
