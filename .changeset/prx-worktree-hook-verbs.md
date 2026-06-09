---
"@bounded-systems/prx": patch
---

feat(workspace): prx owns the `claude --worktree` lifecycle via WorktreeCreate/WorktreeRemove hooks (prx-6jb)

`claude --worktree` errors in the bare-repo + external-worktree layout ("not in
a git repository and no WorktreeCreate hooks are configured"). prx now satisfies
Claude Code's documented hook contract through its own verbs:

- `prx workspace worktree-create` — reads the `{ name }` envelope from stdin,
  reserves + materializes a worktree (keeper does the `git worktree add`), and
  echoes the absolute path (Claude reads it as the session cwd; a non-zero exit
  aborts creation).
- `prx workspace worktree-remove` — reads the `{ worktree_path }` envelope,
  removes the git worktree (keeper) and marks the lifecycle ledger torn_down
  (workspace actor).

Keeper gains `runKeeperRemoveWorktree`, the symmetric counterpart of
`runKeeperEnsureWorktree`, so keeper is the sole owner of both `git worktree add`
and `git worktree remove`/prune; the workspace actor owns only the ledger. The
adapter (`runWorktreeHookCli`) wires Claude's envelope to that split over the
existing `worktree-hook.ts` boundary. Hook registration (a thin pointer to these
verbs) and the wt/wtctl retirement follow separately (prx-arl).
