---
"@bounded-systems/prx": minor
---

Retire worktrunk (wt/wtctl): prx now owns the worktree lifecycle end-to-end (prx-arl). Removes the `prx tools wt` verb (the worktrunk shim) and the dead `prx tools labels sync`, and wires post-create bootstrap (beads `.redirect` + `.pr/local/pr.json` + exclude sync) into the `worktree-create` hook so a fresh `claude --worktree` worktree is self-sufficient without worktrunk. `prx tools git` / `prx tools bd` are unchanged.
