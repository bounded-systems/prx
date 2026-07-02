---
"@bounded-systems/prx": minor
---

Add `prx repo convert-to-bare --from-worktree <path> [--dry-run]` — moves a
standard (non-bare) working copy's `.git` to the canonical
`~/.local/share/git/bare/...` location, recreates the workdir as a linked
worktree on its exact captured branch/commit, restores any stashed tracked
changes and untracked/gitignored content, repairs sibling worktrees'
`.git` pointers, and registers the result. This bakes in a previously
manual, error-prone procedure for consolidating repos into prx's
bare+worktree convention.

Add `prx repo adopt --force` to re-register a repo whose `bare_path` or
`remote_url` has legitimately changed (e.g. after `convert-to-bare`),
bypassing the identity-mismatch refusal.
