---
"@bounded-systems/prx": patch
---

fix(workspace): resolve the repo from a bare repo so `claude --worktree` works (prx-ph7)

`claude --worktree <name>` failed with `workspace.reserve: cwd is not a
recognized GitHub repo`. Claude Code runs `WorktreeCreate`/`WorktreeRemove`
hooks from the **bare repo** (the git common dir), which has no working tree, so
`resolveRepoToplevel` (`git rev-parse --show-toplevel`) returned null and both
`reserve` and `materialize` failed closed.

prx now resolves the layout itself instead of depending on being launched inside
a worktree: when `--show-toplevel` fails, `resolveRepoToplevel` falls back to the
first non-bare worktree from `git worktree list --porcelain` (origin + the
worktree list both resolve fine from a bare repo). keeper's `git worktree add`
already worked from the bare repo — this just feeds reserve/materialize a real
worktree path to compute the sibling placement against. Extracted
`firstNonBareWorktree` as a pure, unit-tested parser.

Fixes the live `claude --worktree` smoke-test failure from the prx-6jb/prx-5q3
rollout.
