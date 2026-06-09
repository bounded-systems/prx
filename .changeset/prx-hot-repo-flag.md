---
"@bounded-systems/prx": patch
---

feat(workspace): `--repo <dir|slug>` makes `claude --worktree` dir-agnostic (prx-hot)

The worktree hooks should resolve the repo explicitly rather than depend on
whatever cwd Claude runs them from. `prx workspace worktree-create|worktree-remove`
now accept `--repo <value>`:

- an existing **directory** → used as the resolution anchor;
- otherwise a **repo-registry slug** → resolved to its `mainWorktree ?? commonDir`
  via the same `loadRepoInventoryConfig → loadRepoInventoryIndex → findRepoBySlug`
  path `prx plan session --repo <slug>` uses.

`prx workspace worktree-hooks [--repo <value>]` bakes `--repo <value>` (shell-quoted)
into the registered `settings.local.json` hook command, so the hook runs from any
cwd. Omitted → plain commands (resolution falls back to the invocation cwd + the
prx-ph7 bare-repo fallback). Verified end-to-end from `/tmp` with both a bare-repo
dir and the `prx` slug.
