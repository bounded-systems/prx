---
"@bounded-systems/prx": patch
---

Fix three more `prx repo convert-to-bare` bugs found dogfooding a repo with
git submodules and sibling worktrees:

- Submodules are now initialized (`git submodule update --init --recursive`)
  in the freshly-created main worktree — previously they were left as empty
  placeholder directories.
- A submodule's own gitdir pointer, and its `core.worktree` setting, inside
  a pre-existing sibling worktree are now repaired — `git worktree repair`
  only fixes the sibling's own top-level `.git` pointer, never a
  submodule's separate, nested references, which go stale once the bare
  moves.
- `git stash push` can report success while creating no new stash entry at
  all (a change `git status --porcelain` shows but that git doesn't
  consider stash-worthy, e.g. a bare submodule-pointer bump). Previously
  this could cause a later blind `git stash pop` to grab whatever
  pre-existing, unrelated stash happened to already sit at `stash@{0}`,
  producing a real conflict against old work with nothing to do with the
  conversion. Now confirmed by checking the pushed message actually landed
  before ever popping.
